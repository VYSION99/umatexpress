from pathlib import Path
from reportlab.pdfgen import canvas
from reportlab.lib.units import mm
from reportlab.lib.colors import HexColor
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont
from reportlab.platypus import Paragraph
from reportlab.lib.styles import ParagraphStyle
from reportlab.graphics.barcode.qr import QrCodeWidget
from reportlab.graphics.shapes import Drawing
from reportlab.graphics import renderPDF
from PIL import Image

ROOT=Path(__file__).resolve().parents[2]
OUT=ROOT/'output/pdf'; OUT.mkdir(parents=True,exist_ok=True)
G='#134E3C'; INK='#17382D'; CREAM='#FBF8EA'; LIME='#D7EE72'; GOLD='#B98D2C'
for name,file in [('Body','DejaVuSans.ttf'),('Bold','DejaVuSans-Bold.ttf')]:
    pdfmetrics.registerFont(TTFont(name,'/usr/share/fonts/dejavu-sans-fonts/'+file))
W,H=303*mm,216*mm
def rect(x,y,w,h,color):
    c.setFillColor(HexColor(color));c.rect(x*mm,H-(y+h)*mm,w*mm,h*mm,fill=1,stroke=0)
def text(s,x,y,w,size=10,color=INK,bold=False):
    p=Paragraph(s,ParagraphStyle('p',fontName='Bold' if bold else 'Body',fontSize=size,leading=size*1.4,textColor=HexColor(color),spaceAfter=0))
    _,h=p.wrap(w*mm,1000);p.drawOn(c,x*mm,H-y*mm-h);return y+h/mm
def label(s,x,y,w,color=G):return text(s.upper(),x,y,w,8,color,True)
def rule(x,y,w):rect(x,y,w,.6,LIME)
def image_crop(path,source,box):
    # Place an existing image through a PDF clipping path; source pixels are unchanged.
    iw,ih=Image.open(path).size;sx,sy,sw,sh=source;x,y,bw,bh=box
    scale=min(bw*mm/sw,bh*mm/sh);dw,dh=sw*scale,sh*scale
    left=x*mm+(bw*mm-dw)/2;bottom=H-(y+bh)*mm+(bh*mm-dh)/2
    c.saveState();p=c.beginPath();p.rect(left,bottom,dw,dh);c.clipPath(p,stroke=0)
    c.drawImage(str(path),left-sx*scale,bottom-(ih-sy-sh)*scale,width=iw*scale,height=ih*scale,mask='auto');c.restoreState()
def qr(x,y,size=32):
    rect(x,y,size,size,'#FFFFFF');q=QrCodeWidget('https://console.umatexpress.com',barLevel='H');bounds=q.getBounds();s=(size-4)*mm/(bounds[2]-bounds[0]);d=Drawing((size-4)*mm,(size-4)*mm,transform=[s,0,0,s,0,0]);d.add(q);renderPDF.draw(d,c,(x+2)*mm,H-(y+size-2)*mm)
def base(outside):
    rect(0,0,303,216,CREAM)
    c.setTrimBox((3*mm,3*mm,300*mm,213*mm));c.setBleedBox((0,0,W,H))
    # Fold indicators are confined to bleed, outside the trimmed artwork.
    for x in ([100,200] if outside else [103,203]):
        c.setStrokeColor(HexColor(G));c.setLineWidth(.3);c.line(x*mm,0,x*mm,2*mm);c.line(x*mm,H-2*mm,x*mm,H)
def brand(x,y,w,white=False,cover=False):
    # Existing transparent brand asset, drawn before panel content.
    c.saveState()
    c.setFillAlpha(.10 if white else .07)
    c.drawImage(str(ROOT/'public/logo-watermark.png'),(x-3)*mm,H-155*mm,
                width=86*mm,height=86*mm,preserveAspectRatio=True,mask='auto')
    c.restoreState()
    if cover:
        text('UMaTeXPRESS',x,y,w,25,G,True)
    else:
        label('UMaTeXPRESS',x,y,w,'#FFFFFF' if white else G)
def feature(x,y,w,title,copy,dark=False):
    col='#FFFFFF' if dark else INK
    yy=text(title,x,y,w,12,col,True);return text(copy,x,yy+2,w,9.5,col)+8

DATA={
 'campusride':dict(service='campusRide',audience='FOR DRIVERS',headline='Drive your<br/>campus forward.',intro='Join campusRide and help students move around campus. Apply through the UMaTeXPRESS Console to begin your driver onboarding.',cover='campusride-cover-source.png',photo=(0,530,507,370),benefits=[('Clearer assignments','Operations assigns your vehicle, zone and corridor after reviewing your application.'),('Organised boarding','Follow the ride queue and confirm boarding with the passenger’s PIN.'),('A connected campus','Help students reach their destinations through dependable service.')],overview='A more organised way to serve campus.',overviewcopy='campusRide connects student transport with a managed ride queue. Your driver console brings your assigned work and boarding controls into one place.',features=[('Assigned service area','Work within the vehicle, zone and corridor assigned by Operations.'),('Managed ride queue','Follow your assigned queue and keep your availability and ride status current.'),('PIN boarding','Use the passenger’s boarding PIN to confirm boarding.')],tour=['Open console.umatexpress.com.','Select Apply or request access.','Choose campusRide driver, then Apply to drive.','Enter your full name, phone number, email address and password.','Submit your application for Operations review.'],note='Operations reviews your application before you can sign in, then assigns your vehicle, zone and corridor.',ui='driver-application.png',uicrop=(42,182,640,1150),uicap='Driver application • Recorded mobile screen',uibody='Use contact details you can access so the team can reach you about your application.',cta='Apply to drive',closing='Help campus journeys run smoothly.'),
 'hostelfinder':dict(service='Hostel Finder',audience='FOR LANDLORDS',headline='Your property.<br/>Their next home.',intro='Introduce your hostel to students looking for accommodation. Start your landlord account through the UMaTeXPRESS Console.',cover='hostelfinder-cover-source.png',photo=(0,483,507,370),benefits=[('Present your property','Explain what your hostel offers through clear property, room and bed-space details.'),('Help students choose','Current information helps students make informed housing decisions.'),('Prepare for discovery','Build your listing in your workspace. Every listing is reviewed before it goes live.')],overview='Help students understand what you offer.',overviewcopy='Present your property, rooms and bed-spaces with clear descriptions and current information. Give students the details they need to consider their next home.',features=[('Property and bed details','Describe your accommodation and the rooms or bed-spaces available.'),('Clear photos','Show the spaces students can expect to see when they visit.'),('Current availability','Keep your listing details and availability up to date.')],tour=['Open console.umatexpress.com.','Select Apply or request access.','Choose Hostel landlord, then Open a landlord account.','Enter your name, phone, email and password. Your business name is optional.','Continue with property and identity details in your private workspace.'],note='You can build your property and beds right away. Every listing is reviewed before it goes live.',ui='landlord-account.png',uicrop=(66,183,590,430),uicap='Landlord account entry • Recorded mobile screen',uibody='On the Get access page, find Hostel landlord and select Open a landlord account to begin.',cta='Open a landlord account',closing='Make the housing search clearer.')}

for key,a in DATA.items():
    c=canvas.Canvas(str(OUT/(key+'-trifold-print.pdf')),pagesize=(W,H))
    c.setTitle(a['service']+' | '+a['audience']+' | A4 tri-fold')
    c.setAuthor('UMaTeXPRESS');base(True)
    # Outside, left to right: tuck flap (97mm), back (100mm), cover (100mm).
    rect(0,0,100,216,G);brand(11,13,80,True)
    label('WHY JOIN '+a['service'],11,31,80,LIME)
    text('Move campus<br/>life forward.' if key=='campusride' else 'Make your<br/>property count.',11,43,78,24,'#FFFFFF',True)
    for i,(title,copy) in enumerate(a['benefits']):
        y=83+i*32
        label('0'+str(i+1),11,y,10,LIME)
        feature(25,y,64,title,copy,True)
        rect(25,y+28,64,.2,'#39715C')
    rule(11,186,15)
    text(a['closing'],11,192,78,11,LIME,True)
    brand(110,13,80);label('YOUR NEXT STEP',110,31,80)
    y=text(a['cta'],110,43,80,25,G,True)
    text('Start with your details.<br/>Build your service workspace.',110,y+7,78,10)
    rect(110,100,80,65,'#FFFFFF')
    qr(113,106,40)
    label('SCAN TO\nGET STARTED',156,109,30)
    text('Open the console on your phone.',156,124,29,9)
    text('console.umatexpress.com',114,153,73,9,G,True)
    text('Choose <b>Apply or request access</b>, then select your service.',110,173,78,10)
    c.linkURL('https://console.umatexpress.com',(110*mm,H-190*mm,192*mm,H-130*mm),relative=0)
    text('Already registered? Sign in to your console account.',110,195,78,8.5)
    brand(210,10,82,cover=True)
    rect(210,29,82,9,G);label(a['service']+' / '+a['audience'],213,31,77,'#FFFFFF')
    text(a['headline'],210,45,82,25,INK,True)
    cover_summary = ('Help students get where they need to go. Manage your assigned rides through one driver workspace.' if key=='campusride' else 'Help students discover their next home. Present your hostel, rooms and bed-spaces in one place.')
    text(cover_summary,210,86,82,10)
    photo=(0,560,507,270) if key=='campusride' else (0,535,507,290)
    image_crop(ROOT/'output/marketing/assets'/a['cover'],photo,(210,114,82,48))
    label('ASSIGNMENTS / QUEUES / PIN BOARDING' if key=='campusride' else 'PROPERTY / PHOTOS / AVAILABILITY',210,168,82)
    rect(200,184,103,32,G)
    text(a['cta']+' →',210,190,82,13,'#FFFFFF',True)
    text('console.umatexpress.com',210,202,82,9,LIME,True)
    c.linkURL('https://console.umatexpress.com',(210*mm,H-209*mm,292*mm,H-195*mm),relative=0)
    c.showPage();base(False)
    # Inside: cover reverse (100mm), centre (100mm), tuck reverse (97mm).
    for x,num,title in [(11,'01','THE SERVICE'),(111,'02','ONBOARDING TOUR'),(211,'03','ON YOUR PHONE')]:
        brand(x,13,80);label(num+' / '+title,x,29,79);rule(x,37,78)
    y=text('Your service.<br/>More organised.' if key=='campusride' else 'Your property.<br/>Clearly presented.',11,44,80,22,G,True)
    text(a['overviewcopy'],11,y+6,80,9.5)
    for i,(title,copy) in enumerate(a['features']):
        y=110+i*29
        rect(11,y,80,25,'#FFFFFF');rect(11,y,1,25,G)
        feature(15,y+3,72,title,copy)
    text('Start your application',111,44,80,22,G,True)
    y=72
    for i,s in enumerate(a['tour'],1):
        rect(111,y+1,7,7,LIME);text(str(i),112.5,y+1,5,10,G,True)
        y=text(s,122,y,69,10)+7
    y=max(y+2,163)
    rect(111,y,80,37,G);label('WHAT HAPPENS NEXT',115,y+4,72,LIME)
    text(a['note'],115,y+12,72,9,'#FFFFFF')
    text('See where to begin',211,44,78,22,G,True)
    if key=='campusride':
        image_crop(ROOT/'output/marketing/assets'/a['ui'],a['uicrop'],(219,69,60,108))
        text(a['uicap'],211,180,78,7.5,G,True);text(a['uibody'],211,190,78,9)
    else:
        text(a['uibody'],211,72,78,10)
        image_crop(ROOT/'output/marketing/assets'/a['ui'],a['uicrop'],(211,107,78,57))
        text(a['uicap'],211,169,78,7.5,G,True)
        text('Account details first. Property and identity details follow in your private workspace.',211,183,78,9)
    c.showPage();c.save()
print('Created both two-page brochures in',OUT)
