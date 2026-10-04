"""Build code-drawn route diagrams, explicitly labelled as illustrations rather than UI screenshots."""
from pathlib import Path
from html import escape
import sys

OUT = Path(__file__).resolve().parents[1] / 'server/gm-wiki/assets/tutorial'
BG, INK, MUTED, GOLD, GREEN, BLUE = '#181324', '#f4edf9', '#c1b6d0', '#ffdc3c', '#7fe0c0', '#77bbff'


def text(x, y, value, size=20, fill=INK):
    return f'<text x="{x}" y="{y}" font-family="Arial,sans-serif" font-size="{size}" fill="{fill}">{escape(value)}</text>'


def rect(x, y, w, h, fill, stroke='none', radius=0):
    return f'<rect x="{x}" y="{y}" width="{w}" height="{h}" rx="{radius}" fill="{fill}" stroke="{stroke}"/>'


def save(name, title, parts, height=580):
    OUT.mkdir(parents=True, exist_ok=True)
    body = ''.join([rect(0, 0, 1120, height, BG), text(32, 46, title, 28), text(32, 77, 'Illustrative diagram • not a live map or editor screenshot', 16, MUTED), *parts])
    (OUT / name).write_text(f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1120 {height}" role="img"><title>{escape(title)}</title>{body}</svg>\n', encoding='utf-8')  # Accessible, scalable diagrams use no scripts, external fonts or fetched images.


def route_map():
    parts = []
    size, ox, oy = 42, 32, 115
    walls = {(x, y) for y in range(9) for x in range(11) if x in (0, 10) or y in (0, 8) or (x == 5 and y != 4)}
    for y in range(9):
        for x in range(11):
            parts.append(rect(ox+x*size, oy+y*size, size-1, size-1, '#4c405b' if (x,y) in walls else '#282334'))
    centre = lambda p: (ox+(p[0]+.5)*size, oy+(p[1]+.5)*size)
    def line(points, colour, dash=''):
        coords = ' '.join(f'{x},{y}' for x,y in map(centre,points))
        return f'<polyline points="{coords}" fill="none" stroke="{colour}" stroke-width="4" stroke-dasharray="{dash}"/>'
    parts += [line([(1,6),(1,2),(3,2)], '#ffffff', '7 6'), line([(3,2),(4,2),(4,4),(6,4),(6,2),(8,2),(8,6)], GOLD)]
    hx,hy = centre((1,6)); parts.append(rect(hx-10,hy-10,20,20,'none','#ffffff'))
    for i,p in enumerate([(3,2),(8,2),(8,6)],1):
        x,y=centre(p);parts += [f'<circle cx="{x}" cy="{y}" r="15" fill="{GOLD}"/>', text(x-6,y+7,str(i),20,BG)]
    for i,(title,detail) in enumerate([
        ('HOME', 'The white square is the placement home.'),
        ('1 → 2: WALK AROUND THE WALL', 'The server fills in the four-way walking steps.'),
        ('2: PAUSE AT A DESTINATION', 'A wait belongs to a waypoint, not a corridor.'),
        ('3: CONTINUE OR TURN AROUND', 'Movement mode chooses what happens next.')
    ]):
        yy=140+i*91;parts += [text(532,yy,title,20,GREEN),text(532,yy+30,detail,18)]
    parts += [text(32,532,'Dashed = approach from home     •     Numbers = clicked destinations     •     Solid = route preview',18,MUTED)]
    save('npc-route-map.svg','Read a route: home, waypoints and the walk between them',parts)


def modes():
    parts=[]
    for i,(label,sequence,note) in enumerate([
        ('Loop', '1 → 2 → 3 → 1 → 2 → 3 …', 'Return to the first waypoint, not automatically to home.'),
        ('Back and forth', '1 → 2 → 3 → 2 → 1 → 2 …', 'Reverse the waypoint order at each end.'),
        ('Walk there and stay', '1 → 2 → 3 → HOLD', 'Remain at the final destination while this route is active.')
    ]):
        y=108+i*133;parts += [rect(24,y,1072,116,'#282334',radius=12),text(44,y+34,label,23,GREEN),text(355,y+37,sequence,29,GOLD),text(355,y+77,note,19)]
    parts += [text(32,538,'Always / active Daily patterns. Interval schedules end after one traversal, then return home.',18,MUTED)]
    save('npc-route-modes.svg','Choose a movement pattern',parts)


def schedules():
    parts=[];x0=290;w=770
    for hour in (0,6,8,12,18,24):parts.append(text(x0+w*hour/24-14,122,f'{hour:02}:00',16,MUTED))
    parts += [text(32,168,'1. Day desk',22,GREEN),rect(x0,141,w,40,'#30263d'),rect(x0+w*8/24,141,w*10/24,40,BLUE),text(x0+w*8/24+12,168,'08:00–18:00 UTC',18,BG)]
    parts += [text(32,238,'2. Always fallback',22,GREEN),rect(x0,211,w,40,GOLD),text(x0+12,238,'Chosen only when route 1 does not match',18,BG)]
    parts += [text(32,300,'Priority: first matching route wins. An Always route in position 1 hides later routes.',21)]
    parts += [text(32,366,'30-minute periods',22,GREEN)]
    for i,label in enumerate(['12:00–12:29','12:30–12:59','13:00–13:29']):
        xx=x0+i*w/3;parts += [rect(xx,335,w/3-8,55,'#514162',radius=5),text(xx+18,371,label,22)]
    parts += [text(32,431,'Save at 12:17: the current period may start immediately if its round is not complete.',20),text(32,472,'It is not “wait 30 minutes after Save.” One completed round is recorded per period.',20),text(32,534,'Overnight example: 22:00 → 06:00 spans midnight. Equal start/end times are invalid.',18,MUTED)]
    save('npc-route-schedules.svg','UTC schedules: windows, priority and interval boundaries',parts)


def workflows():
    parts=[]
    rows=[('Terrain / scenery', 'Pending changes', 'Apply changes', 'Undo / Redo / Discard affect this queue.', BLUE),
          ('NPC routes', 'Waypoints + settings', 'Save routes', 'Route drafts are separate from terrain patches.', GOLD),
          ('Place content', 'Choose content + tile', 'Click to commit', 'A placement is live immediately after a valid click.', GREEN)]
    for i,(first,second,last,note,colour) in enumerate(rows):
        y=116+i*135
        for x,label in [(32,first),(403,second),(774,last)]:
            parts += [rect(x,y,310,65,'#30263d',colour,10),text(x+18,y+40,label,23,colour)]
        parts += [text(353,y+42,'→',32),text(724,y+42,'→',32),text(32,y+101,note,20,MUTED)]
    save('map-editor-workflows.svg','Map tools: three ways to commit a change',parts)


if __name__ == '__main__':
    route_map(); modes(); schedules(); workflows()
    print(f'Wrote four map/route illustrations to {OUT}')
    if '--preview' in sys.argv:
        from xml.etree import ElementTree as ET
        from PIL import Image, ImageDraw, ImageFont
        preview = OUT.parents[3] / 'build/route-wiki-previews'
        preview.mkdir(parents=True, exist_ok=True)
        for source in [*OUT.glob('npc-route-*.svg'), OUT / 'map-editor-workflows.svg']:
            root = ET.fromstring(source.read_text(encoding='utf-8'))
            image = Image.new('RGB', (1120, 580), BG)
            draw = ImageDraw.Draw(image)
            for shape in root:
                tag = shape.tag.rsplit('}', 1)[-1]
                a = shape.attrib
                num = lambda key, default=0: float(a.get(key, default))
                colour = lambda key: None if a.get(key, 'none') == 'none' else a[key]
                if tag == 'rect':
                    draw.rounded_rectangle((num('x'), num('y'), num('x')+num('width'), num('y')+num('height')), radius=num('rx'), fill=colour('fill'), outline=colour('stroke'))
                elif tag == 'circle':
                    draw.ellipse((num('cx')-num('r'), num('cy')-num('r'), num('cx')+num('r'), num('cy')+num('r')), fill=colour('fill'))
                elif tag == 'polyline':
                    points = [tuple(map(float, p.split(','))) for p in a['points'].split()]
                    draw.line(points, fill=a['stroke'], width=int(num('stroke-width', 1)))
                elif tag == 'text':
                    font = ImageFont.truetype('C:/Windows/Fonts/arial.ttf', int(num('font-size', 20)))
                    draw.text((num('x'), num('y')), shape.text, font=font, fill=a['fill'], anchor='ls')
            image.save(preview / (source.stem + '.png'))  # Local review raster; published SVG retains its dashed approach and scalable text.
        print(f'Review rasters: {preview}')
