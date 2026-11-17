/** Fixed document parser, executed only inside the A08 disposable sandbox. No paths/URLs from a model. */
export const documentParserCode = String.raw`
import hashlib, io, json, pathlib, posixpath, re, warnings, zipfile
import xml.etree.ElementTree as ET

MAX_TEXT = 60000
MAX_IMAGES = 6
MAX_UNITS = 100000
W = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main'
A = 'http://schemas.openxmlformats.org/drawingml/2006/main'
P = 'http://schemas.openxmlformats.org/presentationml/2006/main'
S = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main'
R = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships'
C = 'http://schemas.openxmlformats.org/drawingml/2006/chart'
NS = {'w': W, 'a': A, 'p': P, 's': S, 'r': R, 'c': C}
root = pathlib.Path('/workspace')
parts = [root / ('inputs/source-%03d.bin' % i) for i in range(REQUEST['parts'])]
source = b''.join(path.read_bytes() for path in parts)
for path in parts:
    path.unlink()
if hashlib.sha256(source).hexdigest() != REQUEST['sha256']:
    raise ValueError('DOCUMENT_SOURCE_MISMATCH')
query = REQUEST['query']
offset, limit, section = query['offset'], query['limit'], query.get('section')
notes = []
images = []
blocks = []
sections = []
units = []
format_name = REQUEST['format']

def note(value):
    if value not in notes and len(notes) < 100:
        notes.append(value)

def add(kind, location, text='', pictures=None):
    text = str(text).replace('\x00', '')
    pieces = [text[i:i + 12000] for i in range(0, len(text), 12000)] or ['']
    for i, value in enumerate(pieces):
        if len(units) >= MAX_UNITS:
            raise ValueError('DOCUMENT_STRUCTURE_LIMIT')
        units.append({'kind': kind, 'location': location + (':part:%d' % (i + 1) if len(pieces) > 1 else ''), 'text': value, 'pictures': []})
    for picture_index, picture in enumerate(pictures or [], 1):
        if len(units) >= MAX_UNITS:
            raise ValueError('DOCUMENT_STRUCTURE_LIMIT')
        units.append({'kind': 'chart' if isinstance(picture, tuple) else 'image', 'location': location + ':graphic:%d' % picture_index, 'text': '', 'pictures': [picture]})

def export_image(data, location):
    if len(images) >= MAX_IMAGES:
        note('IMAGE_LIMIT: Some images in the requested range were not sent; request fewer units.')
        return None
    try:
        from PIL import Image
        Image.MAX_IMAGE_PIXELS = 20000000
        with warnings.catch_warnings():
            warnings.simplefilter('error', Image.DecompressionBombWarning)
            with Image.open(io.BytesIO(data)) as image:
                image.load()
                if image.width * image.height > 20000000:
                    raise ValueError('IMAGE_PIXEL_LIMIT')
                image.thumbnail((1600, 1600))
                if image.mode in ('RGBA', 'LA'):
                    background = Image.new('RGB', image.size, 'white')
                    background.paste(image.convert('RGBA'), mask=image.convert('RGBA').getchannel('A'))
                    image = background
                else:
                    image = image.convert('RGB')
                path = 'outputs/image-%02d.jpg' % len(images)
                image.save(root / path, format='JPEG', quality=85, optimize=True)
        images.append({'path': path, 'mediaType': 'image/jpeg', 'location': location})
        return len(images) - 1
    except Exception:
        note('IMAGE_UNSUPPORTED: An embedded image could not be rendered at ' + location[:500])
        return None

(root / 'outputs').mkdir(exist_ok=True)
if format_name == 'pdf':
    import pypdfium2 as pdfium
    try:
        document = pdfium.PdfDocument(source)
    except pdfium.PdfiumError as error:
        raise ValueError('DOCUMENT_PDF_ENCRYPTED' if error.err_code in (4, 5) else 'DOCUMENT_PDF_INVALID') from None
    try:
        count = len(document)
        if count == 0:
            note('EMPTY_PDF: The document has no readable pages.')
        if count > MAX_UNITS:
            raise ValueError('DOCUMENT_STRUCTURE_LIMIT')
        if offset > count:
            raise ValueError('DOCUMENT_OFFSET_INVALID')
        end = min(count, offset + min(limit, 4))
        for index in range(offset, end):
            page = document[index]
            try:
                text_page = page.get_textpage()
                try:
                    text = text_page.get_text_range()
                finally:
                    text_page.close()
                if len(text) > 14000:
                    note('PDF_TEXT_PARTIAL: Long page text was bounded; the real page image is also supplied.')
                    text = text[:14000]
                width, height = page.get_size()
                scale = min(2.0, 1600.0 / max(width, height))
                bitmap = page.render(scale=scale)
                try:
                    image = bitmap.to_pil().convert('RGB')
                    path = 'outputs/image-%02d.jpg' % len(images)
                    image.save(root / path, format='JPEG', quality=85, optimize=True)
                    image.close()
                    images.append({'path': path, 'mediaType': 'image/jpeg', 'location': 'page:%d' % (index + 1)})
                    image_index = len(images) - 1
                finally:
                    bitmap.close()
                blocks.append({'kind': 'page', 'location': 'page:%d' % (index + 1), 'text': text or '[No extractable text layer; the actual page image is supplied for visual reading.]', 'imageIndexes': [image_index]})
            finally:
                page.close()
        next_offset = end if end < count else None
        if section is not None:
            note('SECTION_IGNORED: PDF uses page offset rather than a named section.')
    finally:
        document.close()
else:
    try:
        package = zipfile.ZipFile(io.BytesIO(source))
    except Exception:
        raise ValueError('DOCUMENT_PACKAGE_INVALID_OR_ENCRYPTED') from None
    with package:
        members = package.infolist()
        names = [info.filename for info in members]
        if len(names) != len(set(names)) or len(names) > 2048:
            raise ValueError('DOCUMENT_PACKAGE_LIMIT')
        expanded = 0
        for info in members:
            segments = info.filename.rstrip('/').split('/')
            if info.flag_bits & 1 or info.filename.startswith('/') or chr(92) in info.filename or any(segment in ('', '.', '..') for segment in segments) or ':' in info.filename:
                raise ValueError('DOCUMENT_PACKAGE_UNSAFE')
            expanded += info.file_size
            if info.file_size > 16 * 1024 * 1024 or expanded > 64 * 1024 * 1024 or (info.file_size > 1024 * 1024 and info.file_size > max(1, info.compress_size) * 200):
                raise ValueError('DOCUMENT_PACKAGE_LIMIT')
        def xml(name):
            data = package.read(name)
            if b'\x00' in data or b'<!DOCTYPE' in data.upper() or b'<!ENTITY' in data.upper():
                raise ValueError('DOCUMENT_XML_UNSAFE')
            return ET.fromstring(data)
        def relationships(part):
            directory, name = posixpath.split(part)
            relname = posixpath.join(directory, '_rels', name + '.rels')
            result = {}
            if relname not in names:
                return result
            for rel in xml(relname):
                identifier, target = rel.get('Id'), rel.get('Target', '')
                if rel.get('TargetMode') == 'External':
                    note('EXTERNAL_REFERENCE: Linked external resources were not fetched.')
                    continue
                resolved = posixpath.normpath(posixpath.join(directory, target)) if not target.startswith('/') else target.lstrip('/')
                if resolved.startswith('../') or resolved not in names:
                    note('MISSING_RELATIONSHIP: A package relationship is unavailable.')
                    continue
                result[identifier] = resolved
            return result
        def text_of(element, namespace=A):
            return ''.join(node.text or '' for node in element.iter('{%s}t' % namespace))
        def drawings(element, rels):
            pictures = []
            for blip in element.iter('{%s}blip' % A):
                path = rels.get(blip.get('{%s}embed' % R))
                if path:
                    pictures.append(path)
                elif blip.get('{%s}link' % R):
                    note('EXTERNAL_IMAGE: A linked image was not fetched.')
            for chart in element.iter('{%s}chart' % C):
                path = rels.get(chart.get('{%s}id' % R))
                if path:
                    values = [node.text or '' for node in xml(path).iter() if node.tag in ('{%s}v' % C, '{%s}f' % C)]
                    pictures.append(('chart', path, ' | '.join(values)))
            return pictures
        if format_name == 'docx':
            part = 'word/document.xml'
            if part not in names:
                raise ValueError('DOCUMENT_FORMAT_MISMATCH')
            body = xml(part).find('w:body', NS)
            if body is None:
                raise ValueError('DOCUMENT_FORMAT_MISMATCH')
            rels = relationships(part)
            paragraph, table = 0, 0
            for element in body:
                if element.tag == '{%s}p' % W:
                    paragraph += 1
                    value = text_of(element, W)
                    pictures = drawings(element, rels)
                    add('paragraph', 'paragraph:%d' % paragraph, value, pictures)
                    if element.find('.//w:br[@w:type="page"]', NS) is not None or element.find('.//w:lastRenderedPageBreak', NS) is not None:
                        add('metadata', 'paragraph:%d:page-break' % paragraph, '[Explicit or last-saved page break; not a current pagination guarantee.]')
                elif element.tag == '{%s}tbl' % W:
                    table += 1
                    for ri, row in enumerate(element.findall('w:tr', NS), 1):
                        for ci, cell in enumerate(row.findall('w:tc', NS), 1):
                            add('table', 'table:%d:row:%d:column:%d' % (table, ri, ci), '\n'.join(text_of(p, W) for p in cell.findall('.//w:p', NS)), drawings(cell, rels))
            for name in sorted(names):
                if re.match(r'word/(?:header|footer|footnotes|endnotes|comments).*\.xml$', name):
                    add('metadata', name, '\n'.join(text_of(p, W) for p in xml(name).findall('.//w:p', NS)), drawings(xml(name), relationships(name)))
            sections = ['document']
            note('LAYOUT_PARTIAL: Word structure and embedded graphics are read; no full pagination, styles, or page-layout rendering is claimed.')
        elif format_name == 'xlsx':
            if 'xl/workbook.xml' not in names:
                raise ValueError('DOCUMENT_FORMAT_MISMATCH')
            workbook = xml('xl/workbook.xml')
            rels = relationships('xl/workbook.xml')
            shared = []
            if 'xl/sharedStrings.xml' in names:
                shared = [text_of(si, S) for si in xml('xl/sharedStrings.xml')]
            for sheet in workbook.findall('s:sheets/s:sheet', NS):
                name = sheet.get('name', '')
                sections.append(name)
                if section is not None and name != section:
                    continue
                part = rels.get(sheet.get('{%s}id' % R))
                if not part:
                    note('MISSING_SHEET: A workbook sheet relationship is unavailable.')
                    continue
                doc = xml(part)
                state = sheet.get('state', 'visible')
                if state != 'visible':
                    add('metadata', 'sheet:%s:visibility' % name, state)
                for row in doc.findall('s:sheetData/s:row', NS):
                    for cell in row.findall('s:c', NS):
                        coordinate = cell.get('r', '?')
                        value = cell.findtext('s:v', default='', namespaces=NS)
                        if cell.get('t') == 's':
                            try:
                                value = shared[int(value)]
                            except Exception:
                                raise ValueError('DOCUMENT_SHARED_STRING_INVALID') from None
                        elif cell.get('t') == 'inlineStr':
                            value = text_of(cell, S)
                        formula = cell.find('s:f', NS)
                        if formula is not None:
                            value = 'formula=' + (formula.text or '') + '; cachedValue=' + value + '; formulaAttributes=' + json.dumps(formula.attrib, ensure_ascii=False)
                        hidden = ' [hidden row]' if row.get('hidden') == '1' else ''
                        add('cell', 'sheet:%s!%s' % (name, coordinate), value + hidden)
                merged = [item.get('ref', '') for item in doc.findall('s:mergeCells/s:mergeCell', NS)]
                if merged:
                    add('metadata', 'sheet:%s:merged-cells' % name, ', '.join(merged))
                sheet_rels = relationships(part)
                for drawing in doc.findall('s:drawing', NS):
                    drawing_part = sheet_rels.get(drawing.get('{%s}id' % R))
                    if drawing_part:
                        drawing_xml = xml(drawing_part)
                        add('image', 'sheet:%s:drawing:%s' % (name, drawing_part), '[Drawing anchors and graphics; cell values and formulas above are not recalculated.]', drawings(drawing_xml, relationships(drawing_part)))
            if section is not None and section not in sections:
                raise ValueError('DOCUMENT_SECTION_INVALID')
            if 'xl/externalLinks/' in '\n'.join(names):
                note('EXTERNAL_WORKBOOK: External workbook values were not fetched or refreshed.')
            note('FORMULA_CACHED: Formulas are not executed. Cached values and stored formatting can be stale; numeric/date serials are preserved as stored.')
            note('LAYOUT_PARTIAL: Workbook cells, formulas, cached chart data and embedded images are read; no full spreadsheet visual rendering is claimed.')
        else:
            if 'ppt/presentation.xml' not in names:
                raise ValueError('DOCUMENT_FORMAT_MISMATCH')
            presentation = xml('ppt/presentation.xml')
            rels = relationships('ppt/presentation.xml')
            for index, slide in enumerate(presentation.findall('p:sldIdLst/p:sldId', NS), 1):
                sections.append('slide:%d' % index)
                if section is not None and section != 'slide:%d' % index:
                    continue
                part = rels.get(slide.get('{%s}id' % R))
                if not part:
                    note('MISSING_SLIDE: A presentation slide relationship is unavailable.')
                    continue
                slide_doc = xml(part)
                slide_rels = relationships(part)
                tree = slide_doc.find('p:cSld/p:spTree', NS)
                if tree is not None:
                    for shape_index, shape in enumerate(tree, 1):
                        value = '\n'.join(text_of(p) for p in shape.findall('.//a:p', NS))
                        location = 'slide:%d:shape:%d' % (index, shape_index)
                        cells = shape.findall('.//a:tbl/a:tr', NS)
                        if cells:
                            for ri, row in enumerate(cells, 1):
                                for ci, cell in enumerate(row.findall('a:tc', NS), 1):
                                    add('table', location + ':row:%d:column:%d' % (ri, ci), text_of(cell), drawings(cell, slide_rels))
                        elif value or shape.find('.//a:blip', NS) is not None or shape.find('.//c:chart', NS) is not None:
                            add('slide', location, value, drawings(shape, slide_rels))
                for path in slide_rels.values():
                    if path.startswith('ppt/notesSlides/notesSlide') and path.endswith('.xml'):
                        add('metadata', 'slide:%d:notes' % index, text_of(xml(path)))
            if section is not None and section not in sections:
                raise ValueError('DOCUMENT_SECTION_INVALID')
            note('LAYOUT_PARTIAL: Presentation text, tables, chart caches and embedded images are read; no slide-master/SmartArt/animation or exact slide rendering is claimed.')
        if any(name.endswith(('.bin', '.vml')) or '/diagrams/' in name for name in names):
            note('EMBEDDED_CONTENT_PARTIAL: Some embedded objects, macros, vector drawings or diagrams are not executed or fully rendered.')
        count = len(units)
        if offset > count:
            raise ValueError('DOCUMENT_OFFSET_INVALID')
        end = min(count, offset + limit)
        used_text = 0
        for item in units[offset:end]:
            if len(images) >= MAX_IMAGES and any(not isinstance(picture, tuple) for picture in item.get('pictures') or []):
                end = offset + len(blocks)
                note('IMAGE_LIMIT: Continue at nextOffset for remaining embedded graphics.')
                break
            chart_size = sum(len(picture[2]) + len(picture[1]) + 20 for picture in item.get('pictures') or [] if isinstance(picture, tuple))
            if used_text + len(item['text']) + min(chart_size, MAX_TEXT) > MAX_TEXT and blocks:
                end = offset + len(blocks)
                note('TEXT_LIMIT: Continue at nextOffset for the remaining structural units.')
                break
            used_text += len(item['text']) + min(chart_size, MAX_TEXT)
            image_indexes = []
            chart_text = []
            for picture in item.get('pictures') or []:
                if isinstance(picture, tuple):
                    chart_text.append('[Chart cache %s] %s' % (picture[1], picture[2]))
                else:
                    image_index = export_image(package.read(picture), item['location'] + ':' + picture)
                    if image_index is not None:
                        image_indexes.append(image_index)
            text = item['text'] + ('\n' + '\n'.join(chart_text) if chart_text else '')
            if len(text) > 60000:
                text = text[:60000]
                note('CHART_CACHE_PARTIAL: Chart cache text exceeded the bounded unit size.')
            blocks.append({'kind': item['kind'], 'location': item['location'], 'text': text, 'imageIndexes': image_indexes})
        next_offset = end if end < count else None

output = {'format': format_name, 'state': 'partial' if notes or next_offset is not None else 'readable', 'totalUnits': count, 'offset': offset, 'nextOffset': next_offset, 'sections': sections[:1000], 'blocks': blocks, 'images': images, 'warnings': notes}
(root / 'outputs/document.json').write_text(json.dumps(output, ensure_ascii=False), encoding='utf-8')
print('DOCUMENT_READ_COMPLETE')
`;
