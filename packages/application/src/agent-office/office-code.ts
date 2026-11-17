/** Fixed program for the A08 sandbox. JSON intent is injected separately, never interpolated as Python. */
export const officeProgram = String.raw`
import hashlib, io, json, pathlib, posixpath, re, zipfile
from decimal import Decimal
from lxml import etree as ET
from xml.sax.saxutils import escape

ROOT = pathlib.Path('/workspace')
SOURCE = ROOT / ('inputs/source.' + REQUEST['format'])
OUTPUT = ROOT / ('outputs/artifact.' + REQUEST['format'])
W = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main'
S = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main'
A = 'http://schemas.openxmlformats.org/drawingml/2006/main'
R = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships'
NS = {'w': W, 's': S, 'a': A, 'r': R}
warnings = []
changed = []
preserved = {}

def xml(data):
    if re.search(br'<!\s*(?:DOCTYPE|ENTITY)\b', data, re.I):
        raise ValueError('OFFICE_XML_DECLARATION_UNSUPPORTED')
    return ET.fromstring(data, ET.XMLParser(resolve_entities=False, no_network=True, remove_blank_text=False, strip_cdata=False))

def zip_parts(data):
    result = {}
    with zipfile.ZipFile(io.BytesIO(data)) as archive:
        if len(archive.infolist()) > 4096:
            raise ValueError('OFFICE_PACKAGE_LIMIT')
        total = 0
        for item in archive.infolist():
            name = item.filename
            if len(name)>512 or name.startswith('/') or '\\' in name or any(p in ('', '.', '..') for p in name.rstrip('/').split('/')) or name in result:
                raise ValueError('OFFICE_PACKAGE_PATH_INVALID')
            if item.is_dir():
                continue
            total += item.file_size
            if item.file_size > 8*1024*1024 or total > 64*1024*1024 or item.file_size > max(1, item.compress_size)*1000:
                raise ValueError('OFFICE_PACKAGE_LIMIT')
            low = name.lower()
            if any(value in low for value in ('vbaproject', 'activex/', '_xmlsignatures/', 'externallinks/')):
                raise ValueError('OFFICE_ACTIVE_OR_SIGNED_PACKAGE_UNSUPPORTED')
            result[name] = archive.read(item)
            if '/embeddings/' in low:
                if not (low.startswith(('word/embeddings/', 'ppt/embeddings/')) and low.endswith('.xlsx')):
                    raise ValueError('OFFICE_EXECUTABLE_EMBEDDING_UNSUPPORTED')
                embedded = zip_parts(result[name])
                if 'xl/workbook.xml' not in embedded:
                    raise ValueError('OFFICE_EMBEDDED_WORKBOOK_INVALID')
            if low.endswith(('.xml', '.rels')):
                xml(result[name])
    if '[Content_Types].xml' not in result or '_rels/.rels' not in result:
        raise ValueError('OFFICE_PACKAGE_REQUIRED_PART_MISSING')
    for name, data in result.items():
        if not name.endswith('.rels'):
            continue
        base = posixpath.dirname(name).replace('/_rels', '')
        if name == '_rels/.rels':
            base = ''
        for rel in xml(data):
            target = rel.get('Target', '')
            if rel.get('TargetMode') == 'External':
                if 'External relationships are retained as inert references; none was fetched.' not in warnings:
                    warnings.append('External relationships are retained as inert references; none was fetched.')
                continue
            from urllib.parse import unquote
            resolved = posixpath.normpath(posixpath.join(base, unquote(target))) if not target.startswith('/') else target.lstrip('/')
            if resolved.startswith('../') or resolved not in result:
                raise ValueError('OFFICE_RELATIONSHIP_TARGET_MISSING')
    return result

def text_replace(parts, replacements, kind):
    tag = '{%s}t' % (W if kind == 'docx' else A)
    for spec in replacements:
        selected = spec.get('part')
        candidates = [name for name in parts if (name.startswith('word/') if kind == 'docx' else name.startswith('ppt/slides/')) and name.endswith('.xml')]
        if selected:
            if selected not in candidates:
                raise ValueError('OFFICE_TEXT_PART_UNAVAILABLE')
            candidates = [selected]
        pending = {}
        count = 0
        for name in candidates:
            tree = xml(parts[name])
            touched = False
            for node in tree.iter(tag):
                original = node.text or ''
                occurrences = original.count(spec['find'])
                if occurrences:
                    node.text = original.replace(spec['find'], spec['replace'])
                    if node.text.startswith(' ') or node.text.endswith(' '):
                        node.set('{http://www.w3.org/XML/1998/namespace}space', 'preserve')
                    count += occurrences
                    touched = True
            if touched:
                pending[name] = ET.tostring(tree, xml_declaration=True, encoding='UTF-8', standalone=True)
        if count != spec['expectedOccurrences']:
            raise ValueError('OFFICE_TEXT_MATCH_COUNT_CONFLICT_OR_SPLIT_RUN')
        for name, content in pending.items():
            parts[name] = content
            if name not in changed:
                changed.append(name)

def workbook_paths(parts):
    workbook = xml(parts['xl/workbook.xml'])
    relationships = {node.get('Id'): node.get('Target') for node in xml(parts['xl/_rels/workbook.xml.rels'])}
    paths = {}
    for sheet in workbook.findall('s:sheets/s:sheet', NS):
        target = relationships[sheet.get('{%s}id' % R)]
        paths[sheet.get('name')] = target.lstrip('/') if target.startswith('/') else posixpath.normpath(posixpath.join('xl', target))
    return workbook, paths

def column_number(address):
    value = 0
    for char in re.match(r'[A-Z]+', address).group():
        value = value*26+ord(char)-64
    return value

def valid_formula(value):
    if isinstance(value, str) and value.startswith('='):
        if value == '=' or '[' in value or ']' in value or re.search(r'(?i)\b(?:DDE|WEBSERVICE|RTD|HYPERLINK)\s*\(', value) or '|' in value:
            raise ValueError('OFFICE_EXTERNAL_FORMULA_UNSUPPORTED')

def edit_xlsx(parts, edits):
    workbook, paths = workbook_paths(parts)
    modified = {}
    for spec in edits:
        name = paths.get(spec['sheet'])
        if not name:
            raise ValueError('OFFICE_WORKSHEET_UNAVAILABLE')
        tree = modified.setdefault(name, xml(parts[name]))
        address = spec['address']
        if column_number(address) > 16384 or int(re.search(r'[0-9]+', address).group()) > 1048576:
            raise ValueError('OFFICE_CELL_OUT_OF_RANGE')
        for merge in tree.findall('s:mergeCells/s:mergeCell', NS):
            from openpyxl.utils.cell import range_boundaries
            left, top, right, bottom = range_boundaries(merge.get('ref'))
            rownum = int(re.search(r'[0-9]+', address).group())
            if left <= column_number(address) <= right and top <= rownum <= bottom and (column_number(address), rownum) != (left, top):
                raise ValueError('OFFICE_MERGED_CELL_NOT_ANCHOR')
        body = tree.find('s:sheetData', NS)
        if body is None:
            raise ValueError('OFFICE_WORKSHEET_STRUCTURE_INVALID')
        rownum = int(re.search(r'[0-9]+', address).group())
        row = next((item for item in body if int(item.get('r', '0')) == rownum), None)
        if row is None:
            row = ET.Element('{%s}row' % S, r=str(rownum))
            following = next((item for item in body if int(item.get('r', '0')) > rownum), None)
            if following is None: body.append(row)
            else: body.insert(body.index(following), row)
        cell = next((item for item in row if item.get('r') == address), None)
        if cell is None:
            cell = ET.Element('{%s}c' % S, r=address)
            following = next((item for item in row if column_number(item.get('r')) > column_number(address)), None)
            if following is None: row.append(cell)
            else: row.insert(row.index(following), cell)
        for formula in tree.findall('.//s:f',NS):
            if formula.get('t') in ('shared','array','dataTable'):
                ref=formula.get('ref')
                if formula.getparent() is cell:
                    raise ValueError('OFFICE_STRUCTURED_FORMULA_EDIT_UNSUPPORTED')
                if ref:
                    from openpyxl.utils.cell import range_boundaries
                    left,top,right,bottom=range_boundaries(ref)
                    if left<=column_number(address)<=right and top<=rownum<=bottom:
                        raise ValueError('OFFICE_STRUCTURED_FORMULA_EDIT_UNSUPPORTED')
        # Preserve all original style and metadata attributes, replace only the selected value/formula.
        for child in list(cell):
            if ET.QName(child).localname in ('v', 'f', 'is'):
                cell.remove(child)
        cell.attrib.pop('t', None)
        value = spec['value']
        valid_formula(value)
        if isinstance(value, str) and value.startswith('='):
            ET.SubElement(cell, '{%s}f' % S).text = value[1:]
        elif isinstance(value, str):
            cell.set('t', 'inlineStr')
            node = ET.SubElement(ET.SubElement(cell, '{%s}is' % S), '{%s}t' % S)
            node.text = value
            node.set('{http://www.w3.org/XML/1998/namespace}space', 'preserve')
        elif value is not None:
            if isinstance(value, bool): cell.set('t', 'b')
            ET.SubElement(cell, '{%s}v' % S).text = str(int(value)) if isinstance(value, bool) else str(value)
        dim = tree.find('s:dimension', NS)
        if dim is not None:
            tree.remove(dim)
    for name, tree in modified.items():
        parts[name] = ET.tostring(tree, xml_declaration=True, encoding='UTF-8', standalone=True)
        changed.append(name)
    calc = workbook.find('s:calcPr', NS)
    if calc is None: calc = ET.SubElement(workbook, '{%s}calcPr' % S)
    calc.set('fullCalcOnLoad', '1')
    calc.set('forceFullCalc', '1')
    calc.set('calcMode', 'auto')
    parts['xl/workbook.xml'] = ET.tostring(workbook, xml_declaration=True, encoding='UTF-8', standalone=True)
    changed.append('xl/workbook.xml')
    warnings.append('Formula expressions and untouched cached values are preserved. Changed formulas are not evaluated; dependent caches may be stale until Office recalculates. No external formula or macro was executed.')

def create_docx(spec):
    from docx import Document
    from docx.shared import Pt, RGBColor
    doc = Document()
    doc.styles['Normal'].font.name = 'Noto Sans SC'
    doc.styles['Normal'].font.size = Pt(11)
    if spec['title']: doc.add_heading(spec['title'], 0)
    styles = {'title': 'Title', 'heading1': 'Heading 1', 'heading2': 'Heading 2', 'normal': 'Normal', 'bullet': 'List Bullet'}
    for item in spec['paragraphs']:
        paragraph = doc.add_paragraph(style=styles[item['style']])
        run = paragraph.add_run(item['text'])
        run.bold = item['bold']
        if item.get('color'): run.font.color.rgb = RGBColor.from_string(item['color'])
    for rows in spec['tables']:
        width = max(len(row) for row in rows)
        table = doc.add_table(rows=len(rows), cols=width)
        table.style = 'Table Grid'
        for i, row in enumerate(rows):
            for j, value in enumerate(row): table.cell(i, j).text = value
    doc.save(OUTPUT)

def create_xlsx(spec):
    from openpyxl import Workbook
    from openpyxl.styles import Font, PatternFill
    from openpyxl.chart import BarChart, LineChart, Reference
    book = Workbook()
    book.remove(book.active)
    names = set()
    for entry in spec['sheets']:
        if entry['name'].casefold() in names: raise ValueError('OFFICE_DUPLICATE_SHEET')
        names.add(entry['name'].casefold())
        sheet = book.create_sheet(entry['name'])
        sheet.freeze_panes = 'A2'
        for row in entry['rows']:
            for value in row: valid_formula(value)
            sheet.append(row)
        for cell in entry['cells']:
            valid_formula(cell['value'])
            target = sheet[cell['address']]
            target.value = cell['value']
            target.font = Font(name='Noto Sans SC', bold=cell['bold'])
            if cell.get('numberFormat'): target.number_format = cell['numberFormat']
            if cell.get('fill'): target.fill = PatternFill('solid', fgColor=cell['fill'])
        for ordinal, chart in enumerate(entry['charts']):
            data = book.create_sheet('_ath_chart_%d_%d' % (len(names), ordinal + 1))
            data.sheet_state = 'hidden'
            data.append(['Category'] + [series['name'] for series in chart['series']])
            for index, category in enumerate(chart['categories']): data.append([category] + [series['values'][index] for series in chart['series']])
            drawing = BarChart() if chart['kind'] == 'bar' else LineChart()
            drawing.title = chart['title']
            drawing.add_data(Reference(data, min_col=2, max_col=1+len(chart['series']), min_row=1, max_row=1+len(chart['categories'])), titles_from_data=True)
            drawing.set_categories(Reference(data, min_col=1, min_row=2, max_row=1+len(chart['categories'])))
            sheet.add_chart(drawing, 'H%d' % (2 + ordinal*16))
        for col in list(sheet.columns)[:100]: sheet.column_dimensions[col[0].column_letter].width = 20
    book.save(OUTPUT)
    warnings.append('Formulas are stored as formulas and flagged for Office recalculation; this generator does not claim cached formula values have been calculated.')

def create_pptx(spec):
    from pptx import Presentation
    from pptx.util import Inches, Pt
    from pptx.chart.data import CategoryChartData
    from pptx.enum.chart import XL_CHART_TYPE
    from PIL import ImageFont
    def cell_lines(value, width, height):
        for size in range(12,8,-1):
            font=ImageFont.truetype('/usr/local/share/fonts/aitesthub/NotoSansSC.ttf',size=size*4)
            lines=[]
            current=''
            for char in value:
                if char=='\n' or font.getlength(current+char)/4>width:
                    lines.append(current)
                    current='' if char=='\n' else char
                else:current+=char
            lines.append(current)
            if len(lines)*size*1.35<=height:return size,lines
        raise ValueError('OFFICE_SLIDE_TABLE_CONTENT_TOO_DENSE')
    deck = Presentation()
    deck.slide_width = Inches(13.333)
    deck.slide_height = Inches(7.5)
    for entry in spec['slides']:
        slide = deck.slides.add_slide(deck.slide_layouts[6])
        title = slide.shapes.add_textbox(Inches(.6), Inches(.3), Inches(12), Inches(.8)).text_frame
        title.text = entry['title']
        title.paragraphs[0].font.size = Pt(28)
        title.paragraphs[0].font.name = 'Noto Sans SC'
        content = slide.shapes.add_textbox(Inches(.7), Inches(1.3), Inches(12), Inches(1.6 if entry.get('table') or entry.get('chart') else 5.4)).text_frame
        content.word_wrap = True
        for i, value in enumerate(entry['paragraphs']):
            paragraph = content.paragraphs[0] if i == 0 else content.add_paragraph()
            paragraph.text = value
            paragraph.font.size = Pt(18)
            paragraph.font.name = 'Noto Sans SC'
        if entry['paragraphs']:
            content.fit_text(font_family='Noto Sans SC', max_size=18, font_file='/usr/local/share/fonts/aitesthub/NotoSansSC.ttf')
            if any(run.font.size and run.font.size.pt < 10 for paragraph in content.paragraphs for run in paragraph.runs):
                raise ValueError('OFFICE_SLIDE_CONTENT_TOO_DENSE')
        if entry.get('table'):
            rows = entry['table']
            if len(rows)>10 or max(len(row) for row in rows)>8:
                raise ValueError('OFFICE_SLIDE_TABLE_TOO_LARGE')
            table = slide.shapes.add_table(len(rows), max(len(row) for row in rows), Inches(.7), Inches(3.3), Inches(6), Inches(3.3)).table
            for i, row in enumerate(rows):
                for j, value in enumerate(row):
                    cell=table.cell(i,j)
                    size,lines=cell_lines(value,(table.columns[j].width-cell.margin_left-cell.margin_right)/12700,(table.rows[i].height-cell.margin_top-cell.margin_bottom)/12700)
                    cell.text='\n'.join(lines)
                    for paragraph in table.cell(i,j).text_frame.paragraphs:
                        paragraph.font.name = 'Noto Sans SC'
                        paragraph.font.size = Pt(size)
        if entry.get('chart'):
            chart = entry['chart']
            data = CategoryChartData()
            data.categories = chart['categories']
            for series in chart['series']: data.add_series(series['name'], series['values'])
            drawing = slide.shapes.add_chart(XL_CHART_TYPE.COLUMN_CLUSTERED if chart['kind']=='bar' else XL_CHART_TYPE.LINE, Inches(7), Inches(3.1), Inches(5.4), Inches(3.6), data).chart
            drawing.has_title = True
            drawing.chart_title.text_frame.text = chart['title']
    deck.save(OUTPUT)

def register_pdf_font():
    from reportlab.pdfbase import pdfmetrics
    from reportlab.pdfbase.ttfonts import TTFont
    font = '/usr/local/share/fonts/aitesthub/NotoSansSC.ttf'
    if not pathlib.Path(font).is_file(): raise ValueError('OFFICE_CJK_FONT_MISSING')
    pdfmetrics.registerFont(TTFont('ATHNotoSansSC', font))

def make_pdf(pages):
    from reportlab.platypus import SimpleDocTemplate, Paragraph, Spacer, Table, TableStyle, PageBreak
    from reportlab.lib.styles import ParagraphStyle
    from reportlab.lib import colors
    from reportlab.lib.pagesizes import A4
    register_pdf_font()
    stream = io.BytesIO()
    doc = SimpleDocTemplate(stream, pagesize=A4, rightMargin=42, leftMargin=42, topMargin=42, bottomMargin=42)
    style = ParagraphStyle('body', fontName='ATHNotoSansSC', fontSize=11, leading=17, wordWrap='CJK')
    heading = ParagraphStyle('heading', parent=style, fontSize=20, leading=28, spaceAfter=16)
    story = []
    for index, page in enumerate(pages):
        if index: story.append(PageBreak())
        if page['title']: story.append(Paragraph(escape(page['title']), heading))
        for value in page['paragraphs']:
            story.extend([Paragraph(escape(value).replace('\n','<br/>'), style), Spacer(1,8)])
        if page.get('table'):
            rows = page['table']
            width = max(len(row) for row in rows)
            data = [[Paragraph(escape(row[j] if j<len(row) else ''),style) for j in range(width)] for row in rows]
            table = Table(data, colWidths=[(A4[0]-84)/width]*width, repeatRows=1)
            table.setStyle(TableStyle([('GRID',(0,0),(-1,-1),.5,colors.HexColor('#808080')),('BACKGROUND',(0,0),(-1,0),colors.HexColor('#e5efed')),('VALIGN',(0,0),(-1,-1),'TOP'),('TOPPADDING',(0,0),(-1,-1),6),('BOTTOMPADDING',(0,0),(-1,-1),6)]))
            story.append(table)
    doc.build(story)
    return stream.getvalue()

def edit_pdf(data, spec):
    from pypdf import PdfReader, PdfWriter
    reader = PdfReader(io.BytesIO(data), strict=True)
    if reader.is_encrypted: raise ValueError('OFFICE_ENCRYPTED_PDF_UNSUPPORTED')
    root = reader.trailer['/Root']
    if any(key in root for key in ('/AcroForm','/OpenAction','/AA','/Perms')) or root.get('/Names'):
        raise ValueError('OFFICE_ACTIVE_OR_FORM_PDF_UNSUPPORTED')
    writer = PdfWriter()
    for page in reader.pages:
        if page.get('/AA'): raise ValueError('OFFICE_ACTIVE_PDF_UNSUPPORTED')
        for annotation in page.get('/Annots', []):
            annotation = annotation.get_object()
            if annotation.get('/AA') or (annotation.get('/A') and annotation['/A'].get('/S') != '/URI'):
                raise ValueError('OFFICE_ACTIVE_PDF_UNSUPPORTED')
        writer.add_page(page)
    register_pdf_font()
    from reportlab.pdfgen import canvas
    from reportlab.pdfbase import pdfmetrics
    for overlay in spec['overlays']:
        index = overlay['page']-1
        if index >= len(writer.pages): raise ValueError('OFFICE_PDF_PAGE_UNAVAILABLE')
        page = writer.pages[index]
        if overlay['x']+overlay['width']>float(page.mediabox.width) or overlay['y']>float(page.mediabox.height):
            raise ValueError('OFFICE_PDF_OVERLAY_OUT_OF_PAGE')
        buffer = io.BytesIO()
        canv = canvas.Canvas(buffer, pagesize=(float(page.mediabox.width),float(page.mediabox.height)))
        canv.setFont('ATHNotoSansSC',overlay['fontSize'])
        current = ''
        lines = []
        for char in overlay['text']:
            if char == '\n' or pdfmetrics.stringWidth(current+char,'ATHNotoSansSC',overlay['fontSize']) > overlay['width']:
                lines.append(current);current='' if char=='\n' else char
            else: current += char
        lines.append(current)
        for row, line in enumerate(lines): canv.drawString(overlay['x'],overlay['y']-row*overlay['fontSize']*1.4,line)
        canv.save()
        page.merge_page(PdfReader(io.BytesIO(buffer.getvalue())).pages[0])
    if spec['appendPages']:
        writer.append(PdfReader(io.BytesIO(make_pdf(spec['appendPages']))))
    if not spec['overlays'] and not spec['appendPages']: raise ValueError('OFFICE_PDF_EDIT_EMPTY')
    writer.write(OUTPUT)
    warnings.append('PDF overlays add visible text without deleting underlying text. This is not redaction. Original PDF byte layout may be rewritten; only supported static pages are accepted.')

def inspect_file(data, kind):
    if kind == 'pdf':
        import pypdfium2 as pdfium
        document = pdfium.PdfDocument(data)
        if len(document) > 1000: raise ValueError('OFFICE_PDF_PAGE_LIMIT')
        samples = []
        for index in range(min(3,len(document))):
            page = document[index]
            textpage = page.get_textpage()
            samples.append({'location':'page:%d'%(index+1),'text':textpage.get_text_range()[:1000]})
            textpage.close()
            if index == 0 and REQUEST.get('preview'):
                bitmap=page.render(scale=1.0)
                bitmap.to_pil().save(ROOT/'outputs/preview.png')
                bitmap.close()
            page.close()
        result = {'format':kind,'pages':len(document),'samples':samples,'structureChecked':True,'visualLayoutVerified':False}
        document.close()
        return result
    parts = zip_parts(data)
    required = {'docx':'word/document.xml','xlsx':'xl/workbook.xml','pptx':'ppt/presentation.xml'}[kind]
    if required not in parts: raise ValueError('OFFICE_FORMAT_MISMATCH')
    result = {'format':kind,'parts':len(parts),'charts':sum(name.endswith('.xml') and '/charts/chart' in name for name in parts),'images':sum('/media/' in name for name in parts),'structureChecked':True,'visualLayoutVerified':False}
    if kind == 'docx':
        tree = xml(parts[required])
        result.update({'paragraphs':len(tree.findall('.//w:p',NS)),'tables':len(tree.findall('.//w:tbl',NS)),'textSample':' '.join(tree.itertext())[:1500]})
    elif kind == 'xlsx':
        workbook, paths = workbook_paths(parts)
        result['sheets'] = []
        result['sheetCount']=len(paths)
        result['inspectedSheetCount']=min(30,len(paths))
        formula_sample_remaining=20
        for name, path in list(paths.items())[:30]:
            tree = xml(parts[path])
            cells = tree.findall('.//s:c',NS)
            formulas = []
            for cell in cells:
                formula=cell.find('s:f',NS)
                if formula is not None and formula_sample_remaining>0:
                    cached=cell.find('s:v',NS)
                    formulas.append({'cell':cell.get('r'),'formula':(formula.text or '')[:200],'cachedValue':(cached.text or '')[:200] if cached is not None else None})
                    formula_sample_remaining-=1
            count=len(tree.findall('.//s:f',NS))
            result['sheets'].append({'name':name,'cells':len(cells),'formulaCount':count,'formulas':formulas,'formulaSamplePartial':count>len(formulas) or any(len(formula.text or '')>200 for formula in tree.findall('.//s:f',NS))})
        if len(paths)>30:warnings.append('Inspection lists only the first 30 worksheets; all package parts were checked for structural safety.')
        result['formulaCalculation']='not-executed; cached values are original or absent; recalculate in Office before relying on them'
    else:
        slides=sorted(name for name in parts if re.match(r'^ppt/slides/slide[0-9]+\.xml$',name))
        result.update({'slides':len(slides),'textSample':' '.join(' '.join(xml(parts[name]).itertext()) for name in slides[:3])[:1500]})
    return result

try:
    OUTPUT.parent.mkdir(parents=True,exist_ok=True)
    operation=REQUEST['operation']
    kind=REQUEST['format']
    if operation == 'create':
        {'docx':create_docx,'xlsx':create_xlsx,'pptx':create_pptx,'pdf':lambda spec: OUTPUT.write_bytes(make_pdf(spec['pages']))}[kind](REQUEST['spec'])
    elif operation == 'edit':
        source=SOURCE.read_bytes()
        if kind == 'pdf': edit_pdf(source,REQUEST['spec'])
        else:
            parts=zip_parts(source)
            original={name:hashlib.sha256(content).hexdigest() for name,content in parts.items()}
            if kind in ('docx','pptx'):text_replace(parts,REQUEST['spec']['replacements'],kind)
            else:edit_xlsx(parts,REQUEST['spec']['cells'])
            preserved={name:digest for name,digest in original.items() if name not in changed}
            for name,digest in preserved.items():
                if hashlib.sha256(parts[name]).hexdigest()!=digest:raise ValueError('OFFICE_UNTOUCHED_PART_CHANGED')
            with zipfile.ZipFile(OUTPUT,'w',zipfile.ZIP_DEFLATED) as package:
                for name,content in parts.items():package.writestr(name,content)
    elif operation != 'inspect':raise ValueError('OFFICE_OPERATION_UNSUPPORTED')
    data=(SOURCE if operation=='inspect' else OUTPUT).read_bytes()
    if len(data)>4*1024*1024:raise ValueError('OFFICE_OUTPUT_LIMIT')
    report=inspect_file(data,kind)
    report.update({'operation':operation,'sha256':hashlib.sha256(data).hexdigest(),'sizeBytes':len(data),'changedParts':changed[:40],'changedPartCount':len(changed),'changedPartsPartial':len(changed)>40,'preservedPartCount':len(preserved),'preservedPartsSha256':hashlib.sha256(json.dumps(preserved,sort_keys=True,separators=(',',':')).encode()).hexdigest(),'warnings':warnings})
    if len(json.dumps({'officeInspection':report},ensure_ascii=False))>15000:
        raise ValueError('OFFICE_INSPECTION_REPORT_LIMIT')
    if SOURCE.exists():SOURCE.unlink()
    print(json.dumps({'officeInspection':report},ensure_ascii=False))
except Exception as error:
    if OUTPUT.exists():OUTPUT.unlink()
    message=str(error)
    code=message if re.fullmatch(r'OFFICE_[A-Z0-9_]{1,100}',message) else 'OFFICE_FORMAT_OR_OPERATION_INVALID'
    print(json.dumps({'officeError':code},ensure_ascii=False))
    raise RuntimeError(code) from None
`;
