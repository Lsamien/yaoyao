"""Loopback HTTP proxy. All external sockets are owned by the parent broker.
This process has no network interface except guest loopback and no credentials.
"""
import asyncio
import base64
import json
import sys
import uuid
from urllib.parse import urlsplit

PORT = 3128
streams = {}
wire = None
wire_lock = None

async def emit(frame):
    async with wire_lock:
        wire.write((json.dumps(frame, separators=(",", ":")) + "\n").encode())
        await wire.drain()

async def client(reader, writer):
    if len(streams) >= 32:
        writer.close()
        return
    identity = str(uuid.uuid4())
    opened = asyncio.get_running_loop().create_future()
    streams[identity] = (writer, opened)
    connected = False
    try:
        header = await asyncio.wait_for(reader.readuntil(b"\r\n\r\n"), 10)
        if len(header) > 32768:
            raise ValueError("header too large")
        first, rest = header.split(b"\r\n", 1)
        method, target, version = first.decode("ascii").split(" ")
        if version not in ("HTTP/1.0", "HTTP/1.1"):
            raise ValueError("invalid protocol")
        parsed = urlsplit(("//" if method == "CONNECT" else "") + target)
        if not parsed.hostname or parsed.username or parsed.password or parsed.fragment:
            raise ValueError("invalid authority")
        if method != "CONNECT" and parsed.scheme != "http":
            raise ValueError("use CONNECT for HTTPS")
        port = parsed.port or (443 if method == "CONNECT" else 80)
        await emit({"op": "open", "id": identity, "host": parsed.hostname, "port": port})
        await asyncio.wait_for(opened, 15)
        connected = True
        if method == "CONNECT":
            writer.write(b"HTTP/1.1 200 Connection Established\r\n\r\n")
            await writer.drain()
        else:
            path = parsed.path or "/"
            if parsed.query:
                path += "?" + parsed.query
            lines = [line for line in rest.split(b"\r\n") if line and line.split(b":", 1)[0].lower() not in (b"proxy-authorization", b"proxy-connection", b"connection", b"host")]
            authority = ("[" + parsed.hostname + "]") if ":" in parsed.hostname else parsed.hostname
            if port != 80:
                authority += ":" + str(port)
            outgoing = (method + " " + path + " " + version + "\r\nHost: " + authority + "\r\nConnection: close\r\n").encode() + b"\r\n".join(lines) + b"\r\n\r\n"
            await emit({"op": "data", "id": identity, "data": base64.b64encode(outgoing).decode()})
        while True:
            data = await reader.read(32768)
            if not data:
                await emit({"op": "end", "id": identity})
                break
            await emit({"op": "data", "id": identity, "data": base64.b64encode(data).decode()})
    except Exception:
        if not connected:
            writer.write(b"HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\nContent-Length: 0\r\n\r\n")
            with __import__("contextlib").suppress(Exception):
                await writer.drain()
    finally:
        streams.pop(identity, None)
        writer.close()
        with __import__("contextlib").suppress(Exception):
            await emit({"op": "close", "id": identity})

async def main():
    global wire, wire_lock
    loop = asyncio.get_running_loop()
    transport, protocol = await loop.connect_write_pipe(asyncio.streams.FlowControlMixin, sys.stdout.buffer)
    wire = asyncio.StreamWriter(transport, protocol, None, loop)
    wire_lock = asyncio.Lock()
    incoming = asyncio.StreamReader(limit=100000)
    await loop.connect_read_pipe(lambda: asyncio.StreamReaderProtocol(incoming), sys.stdin.buffer)
    server = await asyncio.start_server(client, "127.0.0.1", PORT, limit=32768)
    await emit({"op": "ready", "port": PORT})
    try:
        while True:
            line = await incoming.readline()
            if not line:
                break
            frame = json.loads(line)
            state = streams.get(frame.get("id"))
            if not state:
                continue
            writer, opened = state
            if frame["op"] == "opened":
                if not opened.done():
                    opened.set_result(True)
            elif frame["op"] == "data":
                writer.write(base64.b64decode(frame["data"], validate=True))
                await writer.drain()
            elif frame["op"] in ("close", "error", "end"):
                if not opened.done():
                    opened.set_exception(ConnectionError("network unavailable"))
                elif not opened.cancelled() and opened.exception() is None:
                    writer.close()
    finally:
        server.close()
        await server.wait_closed()
        for writer, opened in list(streams.values()):
            if not opened.done():
                opened.cancel()
            writer.close()
        wire.close()

asyncio.run(main())
