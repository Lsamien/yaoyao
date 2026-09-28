"""A network namespace with only loopback + TUN. No physical/default internet NIC.
All TCP sockets belong to the authenticated parent broker. Guest processes never
receive proxy credentials. Fake DNS maps back to hostnames at the SOCKS boundary;
the parent resolves those through the upstream proxy and checks public addresses.
"""
import asyncio
import base64
import contextlib
import ipaddress
import json
import os
from pathlib import Path
import secrets
import socket
import struct
import subprocess
import sys
import time
import uuid

SOCKS = 3129
DNS = '198.18.0.1'

class Tunnel:
    def __init__(self, send):
        self.send = send
        self.streams = {}
        self.names = {}
        self.addresses = {}

    def dns(self, packet):
        if len(packet) < 12 or packet[2] & 0x80 or struct.unpack('!H', packet[4:6])[0] != 1:
            raise ValueError('invalid DNS')
        end, labels = 12, []
        while end < len(packet) and packet[end]:
            length = packet[end]
            if length > 63 or end + length + 1 > len(packet): raise ValueError('invalid label')
            labels.append(packet[end+1:end+1+length].decode('ascii'))
            end += length + 1
        end += 1
        kind, cls = struct.unpack('!HH', packet[end:end+4])
        question = packet[12:end+4]
        name = '.'.join(labels).lower()
        answer = b''
        if cls == 1 and kind == 1 and name and len(name) <= 253:
            if name not in self.names:
                if len(self.names) >= 65000: raise ValueError('DNS limit')
                address = str(ipaddress.IPv4Address(int(ipaddress.IPv4Address('198.19.0.1')) + len(self.names)))
                self.names[name] = address
                self.addresses[address] = name
            answer = b'\xc0\x0c' + struct.pack('!HHIH', 1, 1, 60, 4) + socket.inet_aton(self.names[name])
        return packet[:2] + struct.pack('!HHHHH', 0x8180, 1, bool(answer), 0, 0) + question + answer

    async def socks(self, reader, writer):
        identity = str(uuid.uuid4())
        opened = asyncio.get_running_loop().create_future()
        if len(self.streams) >= 32:
            writer.close(); return
        self.streams[identity] = (writer, opened)
        try:
            version, count = await asyncio.wait_for(reader.readexactly(2), 10)
            methods = await reader.readexactly(count)
            if version != 5 or 0 not in methods: raise ValueError('SOCKS version')
            writer.write(b'\x05\x00'); await writer.drain()
            version, command, reserved, kind = await reader.readexactly(4)
            if version != 5 or command != 1 or reserved: raise ValueError('TCP CONNECT only')
            if kind == 1: host = socket.inet_ntop(socket.AF_INET, await reader.readexactly(4))
            elif kind == 4: host = socket.inet_ntop(socket.AF_INET6, await reader.readexactly(16))
            elif kind == 3: host = (await reader.readexactly((await reader.readexactly(1))[0])).decode('ascii')
            else: raise ValueError('SOCKS address')
            port = struct.unpack('!H', await reader.readexactly(2))[0]
            await self.send({'op':'open','id':identity,'host':self.addresses.get(host,host),'port':port})
            await asyncio.wait_for(opened, 25)
            writer.write(b'\x05\x00\x00\x01\x00\x00\x00\x00\x00\x00'); await writer.drain()
            while True:
                data = await reader.read(32768)
                if not data:
                    await self.send({'op':'end','id':identity}); break
                await self.send({'op':'data','id':identity,'data':base64.b64encode(data).decode()})
        except Exception:
            with contextlib.suppress(Exception): writer.write(b'\x05\x01\x00\x01'+b'\x00'*6); await writer.drain()
        finally:
            self.streams.pop(identity,None); writer.close()
            with contextlib.suppress(Exception): await self.send({'op':'close','id':identity})

    async def receive(self, frame):
        writer, opened = self.streams.get(frame.get('id'), (None,None))
        if writer is None: return
        if frame['op'] == 'opened':
            if not opened.done(): opened.set_result(True)
        elif frame['op'] == 'data':
            data = base64.b64decode(frame['data'],validate=True)
            if len(data) > 65536: raise ValueError('frame limit')
            writer.write(data); await asyncio.wait_for(writer.drain(),10)
        elif frame['op'] in ('error','end','close'):
            if not opened.done(): opened.set_exception(ConnectionError('network unavailable'))
            writer.close()

    def close(self):
        for writer, opened in list(self.streams.values()):
            if not opened.done(): opened.cancel()
            writer.close()
        self.streams.clear()

class DNSProtocol(asyncio.DatagramProtocol):
    def __init__(self, tunnel): self.tunnel=tunnel
    def connection_made(self, transport): self.transport=transport
    def datagram_received(self, data, addr):
        with contextlib.suppress(Exception): self.transport.sendto(self.tunnel.dns(data),addr)

async def main():
    tun_process = None
    # This container has no workspace mounts or business processes.
    if '--init' in sys.argv:
        subprocess.run(['ip','tuntap','add','mode','tun','dev','tun0'],check=True)
        subprocess.run(['ip','addr','add',DNS+'/15','dev','tun0'],check=True)
        subprocess.run(['ip','link','set','tun0','up'],check=True)
        subprocess.run(['ip','route','add','default','dev','tun0'],check=True)
        argv=['tun2socks','--device','tun0','--proxy','socks5://127.0.0.1:'+str(SOCKS),'--loglevel','error']
        if '--socket' not in sys.argv: os.execvp('tun2socks',argv)
        tun_process=subprocess.Popen(argv,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
    loop=asyncio.get_running_loop()
    queue=asyncio.Queue(maxsize=128)
    async def send(frame): await asyncio.wait_for(queue.put(frame),10)
    tunnel=Tunnel(send)
    tcp=await asyncio.start_server(tunnel.socks,'127.0.0.1',SOCKS)
    dns,_=await loop.create_datagram_endpoint(lambda:DNSProtocol(tunnel),local_addr=(DNS,53))
    async def dns_tcp(reader,writer):
        try:
            while True:
                length=struct.unpack('!H',await reader.readexactly(2))[0]
                answer=tunnel.dns(await reader.readexactly(length))
                writer.write(struct.pack('!H',len(answer))+answer);await writer.drain()
        except Exception: pass
        finally: writer.close()
    dns_server=await asyncio.start_server(dns_tcp,DNS,53)
    try:
        if '--socket' not in sys.argv:
            transport,protocol=await loop.connect_write_pipe(asyncio.streams.FlowControlMixin,sys.stdout.buffer)
            wire=asyncio.StreamWriter(transport,protocol,None,loop)
            incoming=asyncio.StreamReader(limit=200000);await loop.connect_read_pipe(lambda:asyncio.StreamReaderProtocol(incoming),sys.stdin.buffer)
            async def output():
                while True: wire.write((json.dumps(await queue.get())+'\n').encode());await wire.drain()
            task=asyncio.create_task(output());await send({'op':'ready','port':SOCKS})
            try:
                while True:
                    line=await incoming.readline()
                    if not line: break
                    await tunnel.receive(json.loads(line))
            finally: task.cancel();wire.close()
        else:
            path=Path('/run/yaoyao-network/gateway.sock');path.parent.mkdir(parents=True,exist_ok=True)
            path.unlink(missing_ok=True)
            token=None;last_seen=0
            async def http(reader,writer):
                nonlocal token,last_seen
                try:
                    header=await asyncio.wait_for(reader.readuntil(b'\r\n\r\n'),10)
                    lines=header.decode('ascii').split('\r\n');op=lines[0].split(' ')[1].removeprefix('/network-')
                    length=int(next(line.split(':',1)[1] for line in lines[1:] if line.lower().startswith('content-length:')))
                    if not 0<=length<=4*1024*1024: raise ValueError('limit')
                    body=json.loads(await reader.readexactly(length))
                    if body.get('desktopId')!=os.environ['YAOYAO_COMPOSE_DESKTOP_ID']: raise ValueError('identity')
                    if op=='health': result={'ready':Path('/sys/class/net/tun0').exists() and (tun_process is None or tun_process.poll() is None),'version':1}
                    elif op=='open':
                        if token and time.monotonic()-last_seen<30: raise ValueError('busy')
                        tunnel.close()
                        while not queue.empty(): queue.get_nowait()
                        token=secrets.token_hex(32);result={'token':token,'ready':True}
                    else:
                        if not token or not secrets.compare_digest(str(body.get('token','')),token): raise ValueError('token')
                        if op=='close': tunnel.close();token=None;result={'ok':True}
                        elif op=='exchange':
                            for frame in body.get('frames',[]): await tunnel.receive(frame)
                            frames=[]
                            if queue.empty():
                                with contextlib.suppress(asyncio.TimeoutError): frames.append(await asyncio.wait_for(queue.get(),1))
                            while not queue.empty() and len(frames)<32: frames.append(queue.get_nowait())
                            result={'frames':frames}
                        else: raise ValueError('operation')
                    last_seen=time.monotonic()
                    data=json.dumps(result).encode();status='200 OK'
                except Exception: data=b'{"error":"network gateway unavailable"}';status='409 Conflict'
                writer.write(('HTTP/1.1 '+status+'\r\nContent-Type: application/json\r\nx-yaoyao-desktop-id: '+os.environ['YAOYAO_COMPOSE_DESKTOP_ID']+'\r\nContent-Length: '+str(len(data))+'\r\nConnection: close\r\n\r\n').encode()+data)
                with contextlib.suppress(Exception): await writer.drain()
                writer.close()
            async def watchdog():
                nonlocal token
                while True:
                    await asyncio.sleep(5)
                    if tun_process is not None and tun_process.poll() is not None: raise RuntimeError('TUN process stopped')
                    if token and time.monotonic()-last_seen>30: tunnel.close();token=None
            server=await asyncio.start_unix_server(http,str(path));os.chmod(path,0o666)
            async with server: await asyncio.gather(server.serve_forever(),watchdog())
    finally: tcp.close();dns.close();dns_server.close();tunnel.close()

if __name__=='__main__': asyncio.run(main())
