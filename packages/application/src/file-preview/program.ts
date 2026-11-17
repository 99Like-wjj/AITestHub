/** Fixed, read-only preview program. Executed in the disposable, networkless guest. */
export const filePreviewProgram = String.raw`
import csv,hashlib,io,json,os,pathlib,subprocess,zipfile
import xml.etree.ElementTree as ET
root=pathlib.Path('/workspace')
(root/'inputs').mkdir(exist_ok=True)
source=b''.join((root/('inputs/part-%03d.bin'%i)).read_bytes() for i in range(REQUEST['parts']))
for p in (root/'inputs').iterdir():p.unlink()
if hashlib.sha256(source).hexdigest()!=REQUEST['sha256']:raise ValueError('PREVIEW_SOURCE_CHANGED')
fmt=REQUEST['format'];q=REQUEST['query'];notices=[]
base={'sourceSha256':REQUEST['sha256'],'sourceBytes':len(source),'notices':notices}
out=root/'outputs';out.mkdir()
def note(text):
 if text not in notices and len(notices)<30:notices.append(text)
def text(value):
 value='' if value is None else str(value)
 if len(value)>20000:note('部分单元格文本超过20000字符，已在预览中截短。');return value[:20000]
 return value
def package():
 try:z=zipfile.ZipFile(io.BytesIO(source))
 except Exception:raise ValueError('PREVIEW_INVALID_OR_ENCRYPTED')
 infos=z.infolist()
 if len(infos)>10000 or sum(i.file_size for i in infos)>64*1024*1024:raise ValueError('PREVIEW_PACKAGE_LIMIT')
 for i in infos:
  if i.flag_bits&1:raise ValueError('PREVIEW_ENCRYPTED')
  if i.file_size>16*1024*1024:raise ValueError('PREVIEW_PACKAGE_LIMIT')
  if any(s in ('..','')for s in i.filename.rstrip('/').split('/')) or i.filename.startswith('/'):raise ValueError('PREVIEW_PACKAGE_INVALID')
  name=i.filename.lower()
  if 'vbaproject' in name or name.startswith(('basic/','scripts/')):raise ValueError('PREVIEW_ACTIVE_CONTENT')
  if name.endswith(('.xml','.rels')):
   body=z.read(i)
   if b'\x00' in body or b'<!DOCTYPE' in body.upper() or b'<!ENTITY' in body.upper():raise ValueError('PREVIEW_ACTIVE_CONTENT')
 return z
def finish(data):
 encoded=json.dumps(data,ensure_ascii=False).encode()
 if len(encoded)>3900000:raise ValueError('PREVIEW_RESULT_LIMIT')
 (out/'preview.json').write_bytes(encoded)
def workbook(sheets,selected,rows,offset,columns_truncated=False):
 finish({**base,'kind':'workbook','sheets':sheets,'selectedSheet':selected,'rowOffset':offset,'rows':rows,'hasMoreRows':offset+len(rows)<sheets[selected]['rowCount'],'columnsTruncated':columns_truncated})
def cell(column,value,formula=None,cached=True):
 return {'column':column,'text':text(value),'formula':None if formula is None else text(formula),'cacheState':'notFormula'if formula is None else('available'if cached else'missing')}
if fmt in ('csv','tsv'):
 if q['sheet']!=0:raise ValueError('PREVIEW_SHEET_NOT_FOUND')
 try:s=source.decode('utf-8-sig')
 except UnicodeError:raise ValueError('PREVIEW_ENCODING')
 reader=csv.reader(io.StringIO(s),delimiter='\t'if fmt=='tsv'else',');rows=[];n=0;cols=0
 csv.field_size_limit(1024*1024)
 for values in reader:
  if n>=100000 or len(values)>10000:raise ValueError('PREVIEW_WORKBOOK_LIMIT')
  cols=max(cols,len(values))
  if q['offset']<=n<q['offset']+q['limit']:rows.append({'index':n,'cells':[cell(i,v)for i,v in enumerate(values[:200])]})
  n+=1
 if cols>200:note('每行仅预览前200列。')
 workbook([{'index':0,'name':'数据','rowCount':n,'columnCount':cols}],0,rows,q['offset'],cols>200)
elif fmt=='xlsx':
 z=package();z.close()
 import openpyxl
 book=openpyxl.load_workbook(io.BytesIO(source),read_only=True,data_only=False,keep_links=False)
 cached=openpyxl.load_workbook(io.BytesIO(source),read_only=True,data_only=True,keep_links=False)
 if len(book.worksheets)>100:raise ValueError('PREVIEW_WORKBOOK_LIMIT')
 sheets=[]
 for i,sheet in enumerate(book.worksheets):
  if sheet.max_row is None or sheet.max_column is None:sheet.calculate_dimension(force=True)
  sheets.append({'index':i,'name':sheet.title[:256],'rowCount':sheet.max_row or 0,'columnCount':sheet.max_column or 0})
 if q['sheet']>=len(sheets):raise ValueError('PREVIEW_SHEET_NOT_FOUND')
 meta=sheets[q['sheet']];sheet=book.worksheets[q['sheet']];cache=cached.worksheets[q['sheet']];rows=[]
 if meta['rowCount']>1000000 or meta['columnCount']>16384:raise ValueError('PREVIEW_WORKBOOK_LIMIT')
 start=q['offset']+1;end=min(meta['rowCount'],q['offset']+q['limit'])
 if start<=end:
  values=sheet.iter_rows(min_row=start,max_row=end,max_col=min(meta['columnCount'],200))
  cached_values=cache.iter_rows(min_row=start,max_row=end,max_col=min(meta['columnCount'],200))
  for index,(line,cacheline)in enumerate(zip(values,cached_values),q['offset']):
   cells=[]
   for column,(c,cc)in enumerate(zip(line,cacheline)):
    formula=c.value if c.data_type=='f'else None
    cells.append(cell(column,cc.value if formula else c.value,formula,cc.value is not None))
   rows.append({'index':index,'cells':cells})
 note('公式未重新计算；显示文件保存的缓存值，缺失缓存的公式不显示虚构结果。')
 if meta['columnCount']>200:note('每行仅预览前200列。')
 workbook(sheets,q['sheet'],rows,q['offset'],meta['columnCount']>200)
 book.close();cached.close()
elif fmt=='ods':
 z=package();body=z.read('content.xml');document=ET.fromstring(body);z.close()
 T='{urn:oasis:names:tc:opendocument:xmlns:table:1.0}';O='{urn:oasis:names:tc:opendocument:xmlns:office:1.0}';P='{urn:oasis:names:tc:opendocument:xmlns:text:1.0}'
 tables=document.findall('.//'+T+'table')
 if not tables or len(tables)>100:raise ValueError('PREVIEW_WORKBOOK_LIMIT')
 sheets=[];rows=[];truncated=False
 for si,table in enumerate(tables):
  count=0;maxcol=0
  for row in table.iter(T+'table-row'):
   repeat=int(row.get(T+'number-rows-repeated','1'))
   if repeat<1 or repeat>100000 or count+repeat>100000:raise ValueError('PREVIEW_WORKBOOK_LIMIT')
   cells=[];column=0
   for c in row:
    if c.tag not in (T+'table-cell',T+'covered-table-cell'):continue
    repeats=int(c.get(T+'number-columns-repeated','1'))
    if repeats<1 or column+repeats>100000:raise ValueError('PREVIEW_WORKBOOK_LIMIT')
    formula=c.get(T+'formula');value=c.get(O+'value')or c.get(O+'boolean-value')or c.get(O+'date-value')
    paragraphs=[''.join(p.itertext())for p in c.findall(P+'p')]
    if paragraphs:value='\n'.join(paragraphs)
    if si==q['sheet']:
     for ci in range(column,min(column+repeats,200)):cells.append(cell(ci,value,formula,value is not None))
    column+=repeats
   maxcol=max(maxcol,column)
   if si==q['sheet']:
    for index in range(max(count,q['offset']),min(count+repeat,q['offset']+q['limit'])):rows.append({'index':index,'cells':cells})
   count+=repeat
  sheets.append({'index':si,'name':table.get(T+'name','工作表')[:256],'rowCount':count,'columnCount':maxcol})
 if q['sheet']>=len(sheets):raise ValueError('PREVIEW_SHEET_NOT_FOUND')
 note('公式未重新计算；展示原文件保存的内容及公式。')
 if sheets[q['sheet']]['columnCount']>200:note('每行仅预览前200列。')
 workbook(sheets,q['sheet'],rows,q['offset'],sheets[q['sheet']]['columnCount']>200)
else:
 if fmt not in ('docx','pptx','odt','odp'):raise ValueError('PREVIEW_UNSUPPORTED')
 z=package();z.close()
 source_path=root/('source.'+fmt);source_path.write_bytes(source)
 profile=root/'lo-profile';profile.mkdir()
 (profile/'user').mkdir()
 (profile/'user'/'registrymodifications.xcu').write_text('''<?xml version="1.0" encoding="UTF-8"?><oor:items xmlns:oor="http://openoffice.org/2001/registry"><item oor:path="/org.openoffice.Office.Common/Security/Scripting"><prop oor:name="MacroSecurityLevel" oor:op="fuse"><value>3</value></prop><prop oor:name="DisableMacrosExecution" oor:op="fuse"><value>true</value></prop></item><item oor:path="/org.openoffice.Office.Common/Load"><prop oor:name="UpdateDocMode" oor:op="fuse"><value>0</value></prop></item></oor:items>''')
 env={**os.environ,'HOME':str(root),'SAL_USE_VCLPLUGIN':'svp','OMP_NUM_THREADS':'1','TMPDIR':'/tmp'}
 try:
  result=subprocess.run(['libreoffice','-env:UserInstallation='+profile.as_uri(),'--headless','--invisible','--nologo','--nodefault','--nolockcheck','--norestore','--convert-to','pdf','--outdir',str(out),str(source_path)],stdin=subprocess.DEVNULL,stdout=subprocess.PIPE,stderr=subprocess.PIPE,timeout=85,env=env)
 except FileNotFoundError:raise ValueError('PREVIEW_CONVERTER_UNAVAILABLE')
 except subprocess.TimeoutExpired:raise ValueError('PREVIEW_CONVERSION_TIMEOUT')
 target=out/'source.pdf'
 if result.returncode!=0 or not target.is_file():raise ValueError('PREVIEW_CONVERSION_FAILED')
 pdf=target.read_bytes()
 if not pdf.startswith(b'%PDF-'):raise ValueError('PREVIEW_CONVERSION_FAILED')
 if len(pdf)>4*1024*1024:raise ValueError('PREVIEW_RESULT_LIMIT')
 import shutil
 source_path.unlink();shutil.rmtree(profile)
 note('此为原文件转换的只读预览，字体及复杂排版可能与原应用有差异。')
 finish({**base,'kind':'pdf','mediaType':'application/pdf','contentBase64':''})
`;
