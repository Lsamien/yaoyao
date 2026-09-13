import json, pathlib, subprocess, statistics
root=pathlib.Path(__file__).resolve().parent;out=root
network=[json.loads(s) for s in (out/'network.jsonl').read_text().splitlines()]
rows=[]
for product,bundle in [('yaoyao','cn.samien.yaoyao.hermes'),('openmausbot','cn.samien.hermes.bot')]:
 for f in sorted(out.glob(f'{product}-latency-series-*.jsonl')):
  events=[json.loads(s) for s in f.read_text().splitlines()]
  starts=[e for e in events if e['name']=='send_start']
  for i,start in enumerate(starts):
   t=start['time'];end=starts[i+1]['time'] if i+1<len(starts) else t+60
   e=[x for x in events if t<=x['time']<end]
   n=[x for x in network if x.get('app')==product and t<=x['time']<end]
   send=next((x for x in n if x.get('event')=='request' and x.get('method')=='POST' and x['path'].endswith('/messages')),None)
   if not send:continue
   run=send['run'];n=[x for x in n if x.get('run')==run]; first=lambda name:next((x['time'] for x in e if x['name']==name),None)
   views=[x for x in e if x['name']=='view_text' and x['detail'].startswith('assistant|') and int(x['detail'].split('|')[-1])>0]
   source=[x for x in n if x.get('event')=='upstream_text' and x.get('chars',0)>0]
   ms=lambda value:round((value-t)*1000,2) if value else None
   gaps=[(b['time']-a['time'])*1000 for a,b in zip(views,views[1:]) if b['time']-a['time']<2]
   row=dict(product=product,run=run,traceFile=f.name.removeprefix(product+'-'),sample=i+1,postAckMs=ms(first('post_ack')),sendReadyMs=ms(first('send_ready')),firstViewMs=ms(views[0]['time']) if views else None,firstUpstreamMs=ms(source[0]['time']) if source else None,viewUpdates=len(views),upstreamTextEvents=len(source),medianViewGapMs=round(statistics.median(gaps),2) if gaps else None,largestViewGapMs=round(max(gaps),2) if gaps else None)
   if views and source:row['firstDeliveryToViewMs']=round((views[0]['time']-source[0]['time'])*1000,2)
   row['upstreamTextFrameBytes']=sum(x.get('bytes',0) for x in source)
   row['lastViewChars']=int(views[-1]['detail'].split('|')[-1]) if views else None
   row['requestsAfterSend']=[x['path'] for x in n if x.get('event')=='request' and x['time']<t+5]
   rows.append(row)
(out/'measurements.json').write_text(json.dumps(rows,ensure_ascii=False,indent=2))
for r in rows:print(json.dumps({k:v for k,v in r.items() if k!='requestsAfterSend'},ensure_ascii=False))
