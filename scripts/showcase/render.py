#!/usr/bin/env python3
"""Edit captured browser footage into a narrated film with an original score.

Requires Pillow, NumPy, SciPy and FFmpeg. Inputs live in output/showcase-2026;
the finished MP4, poster, captions and music are written to docs/.
"""
import argparse
import bisect
import functools
import json
import math
import subprocess
import textwrap
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw, ImageFont, ImageFilter
from scipy.io import wavfile
from scipy.signal import resample_poly, butter, sosfilt

ROOT = Path(__file__).resolve().parents[2]
WORK = ROOT / 'output/showcase-2026'
DOCS = ROOT / 'docs'
W, H, FPS, SR = 1920, 1080, 30, 48000
GOLD, MINT, WHITE, MUTED = '#f3cf86', '#a9e6cf', '#f4f1e8', '#9fb2b8'
SCENES = json.loads(Path(__file__).with_name('storyboard.json').read_text())
FONT_DIR = Path('/usr/share/fonts')


@functools.lru_cache(maxsize=50)
def font(size, style='sans'):
    path = {
        'sans': 'opentype/inter/Inter-Regular.otf',
        'bold': 'opentype/inter/Inter-SemiBold.otf',
        'serif': 'truetype/dejavu/DejaVuSerif.ttf',
        'italic': 'truetype/dejavu/DejaVuSerif-Italic.ttf',
    }[style]
    return ImageFont.truetype(str(FONT_DIR / path), size)


def smooth(x):
    x = max(0, min(1, x))
    return x * x * (3 - 2 * x)


def read_audio(path):
    rate, audio = wavfile.read(path)
    if np.issubdtype(audio.dtype, np.integer):
        audio = audio.astype(np.float32) / np.iinfo(audio.dtype).max
    if audio.ndim > 1:
        audio = audio.mean(axis=1)
    return resample_poly(audio, SR, rate).astype(np.float32)


elapsed = 0
for scene in SCENES:
    audio = read_audio(WORK / 'narration' / (scene['id'] + '.wav'))
    # Natural pauses win over squeezing narration into an arbitrary cut length.
    scene['duration'] = max(scene['duration'], math.ceil((len(audio) / SR + 1.1) * 2) / 2)
    scene['at'] = elapsed
    scene['audio'] = audio
    elapsed += scene['duration']
TOTAL = elapsed


def original_audio():
    """Original 80 BPM ambient composition; no sampled commercial recordings."""
    rng = np.random.default_rng(23)
    n = round(TOTAL * SR)
    music = np.zeros((n, 2), np.float32)
    effects = np.zeros_like(music)
    speech = np.zeros_like(music)

    def add(buffer, sound, at, gain=1, pan=0):
        start = round(at * SR)
        if start < 0 or start >= n:
            return
        size = min(len(sound), n - start)
        angles = (pan + 1) * np.pi / 4
        buffer[start:start+size, 0] += sound[:size] * (gain * np.cos(angles))
        buffer[start:start+size, 1] += sound[:size] * (gain * np.sin(angles))

    def hz(note):
        return 440 * 2 ** ((note - 69) / 12)

    def pad(note, duration=5.6):
        t = np.arange(round(duration * SR), dtype=np.float32) / SR
        f = hz(note)
        tone = np.sin(2*np.pi*f*t) + .23*np.sin(2*np.pi*f*1.002*t+.3) + .12*np.sin(4*np.pi*f*t)
        envelope = np.minimum(t/.9, 1) * np.minimum((duration-t)/2.5, 1)
        return tone * envelope * (.9 + .1*np.sin(2*np.pi*.18*t))

    def bell(note, duration=2):
        t = np.arange(round(duration * SR), dtype=np.float32) / SR
        f = hz(note)
        tone = np.sin(2*np.pi*f*t + 1.3*np.sin(2*np.pi*f*2*t)*np.exp(-t*4))
        tone += .18*np.sin(2*np.pi*f*3*t)*np.exp(-t*5)
        return tone * np.minimum(t/.012, 1) * np.exp(-t*2.6) * np.minimum((duration-t)/.2, 1)

    beat = .75
    chords = [[57,60,64,67,71], [53,57,60,64,67], [55,60,64,67,74], [55,59,62,67,69]]
    basses = [33,29,36,31]
    melody = [76,79,83,81,79,76,74,72]
    for bar in range(math.ceil(TOTAL/3)):
        at = bar*3
        chord = chords[(bar//2)%4]
        for j, note in enumerate(chord):
            add(music, pad(note), at, .021, (j-2)*.33)
        # Sparse, delayed starlight arpeggios.
        for step in [0,2,3,5,6]:
            note = chord[(step+bar)%len(chord)] + 12
            tone = bell(note)
            t0 = at + step*beat/2
            add(music, tone, t0, .034, (-1 if step%2 else 1)*.5)
            add(music, tone, t0+.375, .011, (-1 if step%2 else 1)*-.5)
            add(music, tone, t0+.75, .005, .2)
        if bar%2 == 0:
            add(music, bell(melody[(bar//2)%8], 3), at+.75, .043, .15)
        if 4 <= bar < math.floor(TOTAL/3)-2:
            t = np.arange(round(2.4*SR), dtype=np.float32)/SR
            bass = np.sin(2*np.pi*hz(basses[(bar//2)%4])*t) * np.minimum(t/.04,1)*np.exp(-t*1.3)
            add(music,bass,at,.12)
            for b in [0,2]:
                t = np.arange(round(.28*SR),dtype=np.float32)/SR
                kick = np.sin(2*np.pi*(48*t + 38*.035*(1-np.exp(-t/.035))))*np.exp(-t*19)
                add(music,kick,at+b*beat,.075)
            for b in range(8):
                noise = rng.normal(0,1,round(.09*SR)).astype(np.float32)
                noise = sosfilt(butter(2,6500,fs=SR,btype='highpass',output='sos'),noise)
                noise *= np.exp(-np.arange(len(noise))/SR*65)
                add(music,noise,at+b*beat/2,.012 if b%2 else .006, .5 if b%2 else -.5)
    # Wide, quiet echoes keep the score airy without masking consonants.
    dry = music.copy()
    for delay, gain in [(.19,.12),(.43,.1),(.81,.075),(1.37,.05)]:
        offset = round(delay*SR)
        music[offset:] += dry[:-offset, ::-1]*gain
    del dry

    subtitle_segments = []
    for scene in SCENES:
        voice = scene['audio'].copy()
        voice = sosfilt(butter(2,80,fs=SR,btype='highpass',output='sos'),voice).astype(np.float32)
        rms = np.sqrt(np.mean(voice**2))
        voice *= min(.14/max(rms,.001), .78/max(np.max(np.abs(voice)),.001))
        fade = min(round(.015*SR),len(voice)//2)
        voice[:fade] *= np.linspace(0,1,fade)
        voice[-fade:] *= np.linspace(1,0,fade)
        add(speech,voice,scene['at']+.55,1.0)
        phrases = textwrap.wrap(scene['voice'], width=70, break_long_words=False)
        voice_length = len(voice)/SR
        total_chars = sum(len(p) for p in phrases)
        cursor = scene['at']+.55
        for phrase in phrases:
            length = voice_length*len(phrase)/total_chars
            subtitle_segments.append({'start':cursor,'end':cursor+length,'text':phrase})
            cursor += length
        # Soft transition swoosh. A restrained cue, never a loud trailer hit.
        t = np.arange(round(.45*SR),dtype=np.float32)/SR
        swoosh = sosfilt(butter(2,[500,3300],fs=SR,btype='bandpass',output='sos'),rng.normal(0,1,len(t)))
        swoosh *= np.sin(np.pi*t/.45)**2
        if scene['at']:
            add(effects,swoosh,scene['at']-.18,.028,-.2)
        if scene['id'] in ['01-passport','02-evening','03-discover','05-journey']:
            for offset in [1.25,3.15]:
                add(effects,bell(88,.28),scene['at']+offset,.065,.25)
        if scene['id'] in ['07-joined','08-circle','10-outro']:
            for j,note in enumerate([72,76,79,84]):
                add(effects,bell(note,1.8),scene['at']+.12+j*.11,.065,(j-1.5)*.25)
    # Smooth ducking under speech; narration remains comfortably in front.
    energy = np.max(np.abs(speech),axis=1)
    block = 480
    coarse = np.array([np.max(energy[i:i+block]) for i in range(0,n,block)])
    envelope = np.zeros_like(coarse)
    for i,value in enumerate(coarse):
        target = 1.0 if value>.012 else 0.0
        prev = envelope[i-1] if i else 0
        envelope[i] = prev + (target-prev)*(.6 if target>prev else .025)
    duck = np.interp(np.arange(n),np.arange(len(coarse))*block,envelope)
    music *= (.85-.5*duck[:,None])
    edge = np.minimum(np.arange(n)/(SR*2),1) * np.minimum((n-np.arange(n))/(SR*3),1)
    music *= edge[:,None]
    mix = music+effects+speech
    mix *= np.minimum((n-np.arange(n))/(SR*.8),1)[:,None]
    peak = float(np.max(np.abs(mix)))
    if peak>.92:
        mix *= .92/peak
    wavfile.write(WORK/'mix.wav',SR,(mix*32767).astype(np.int16))
    wavfile.write(WORK/'music.wav',SR,(music*min(2,.85/max(float(np.max(np.abs(music))),.01))*32767).astype(np.int16))
    print(f'Original stereo score, effects and narration: {TOTAL:.1f}s, peak {peak:.3f}',flush=True)
    return subtitle_segments


def timestamp(t, comma=True):
    ms=round(t*1000)
    return f'{ms//3600000:02}:{ms//60000%60:02}:{ms//1000%60:02}{"," if comma else "."}{ms%1000:03}'


def captions(segments):
    srt='\n\n'.join(f'{i+1}\n{timestamp(s["start"])} --> {timestamp(s["end"])}\n{s["text"]}' for i,s in enumerate(segments))+'\n'
    (DOCS/'showcase.en.srt').write_text(srt)
    vtt='WEBVTT\n\n'+'\n\n'.join(f'{timestamp(s["start"],False)} --> {timestamp(s["end"],False)}\n{s["text"]}' for s in segments)+'\n'
    (DOCS/'showcase.en.vtt').write_text(vtt)


yy,xx=np.mgrid[0:H,0:W].astype(np.float32)
blue=np.exp(-((xx-1550)**2/(900**2)+(yy-240)**2/(650**2)))
teal=np.exp(-((xx-280)**2/(900**2)+(yy-1000)**2/(800**2)))
purple=np.exp(-((xx-1050)**2/(700**2)+(yy-620)**2/(700**2)))
bg=np.stack([5+blue*15+teal*3+purple*8,10+blue*20+teal*22+purple*4,20+blue*38+teal*20+purple*18],axis=-1)
BACKGROUND=Image.fromarray(np.uint8(bg),'RGB')
del yy,xx,blue,teal,purple,bg
rng=np.random.default_rng(84)
STARS=[(int(rng.integers(20,W-20)),int(rng.integers(20,H-20)),float(rng.random()),float(rng.random()*6)) for _ in range(125)]


def sparkle(draw,x,y,r,color):
    draw.polygon([(x,y-r),(x+r*.25,y-r*.25),(x+r,y),(x+r*.25,y+r*.25),(x,y+r),(x-r*.25,y+r*.25),(x-r,y),(x-r*.25,y-r*.25)],fill=color)


@functools.lru_cache(maxsize=40)
def captured_image(name, crop):
    return Image.open(WORK/'captures'/(name+'.png')).convert('RGB').crop(crop)


def get_footage(scene,t):
    shot=captured_image(scene['capture'],tuple(scene['crop']))
    # A restrained camera move over the actual interface, without altering its content.
    zoom=1+.016*smooth(t/scene['duration'])
    width,height=round(shot.width/zoom),round(shot.height/zoom)
    x=(shot.width-width)//2; y=(shot.height-height)//2
    return shot.crop((x,y,x+width,y+height))


def wrapped(draw,text,xy,width,size=25,color=MUTED,line_height=36,style='sans'):
    x,y=xy
    words=text.split();line=''
    for word in words:
        proposed=(line+' '+word).strip()
        if draw.textlength(proposed,font=font(size,style))>width and line:
            draw.text((x,y),line,font=font(size,style),fill=color);y+=line_height;line=word
        else:line=proposed
    if line:draw.text((x,y),line,font=font(size,style),fill=color);y+=line_height
    return y


def base(t,scene):
    im=BACKGROUND.copy();d=ImageDraw.Draw(im)
    for x,y,depth,phase in STARS:
        strength=int(55+105*depth*(.65+.35*math.sin(t*.7+phase)))
        color=(strength,int(strength*.96),int(strength*.83))
        r=1+int(depth>.85)
        d.ellipse((x-r,y-r,x+r,y+r),fill=color)
        if depth>.97:sparkle(d,x,y,5,color)
    d.line((76,110,W-76,110),fill='#29404b',width=1)
    sparkle(d,92,63,17,GOLD)
    d.text((128,42),'star gazer',font=font(34,'serif'),fill=WHITE)
    d.text((340,53),'LOOK UP, TOGETHER',font=font(14,'bold'),fill=MUTED)
    d.rounded_rectangle((W-425,40,W-76,80),radius=20,fill='#152731',outline='#34505a')
    d.ellipse((W-408,55,W-398,65),fill=MINT)
    d.text((W-385,49),'FIND YOUR KIND OF NIGHT',font=font(14,'bold'),fill=MINT)
    d.line((76,H-28,W-76,H-28),fill='#29404b',width=2)
    d.line((76,H-28,76+(W-152)*t/TOTAL,H-28),fill=GOLD,width=3)
    return im


def scene_image(scene,local,t):
    im=base(t,scene);d=ImageDraw.Draw(im)
    if scene.get('kind') in ['intro','outro']:
        ending=scene['kind']=='outro'
        hero=dict(scene,capture='01-discover',crop=[1390,145,1900,520],duration=scene['duration'])
        planet=get_footage(hero,local).resize((850,626),Image.Resampling.LANCZOS)
        mask=Image.new('L',planet.size,0);md=ImageDraw.Draw(mask)
        md.ellipse((55,15,815,605),fill=235)
        mask=mask.filter(ImageFilter.GaussianBlur(65))
        im.paste(planet,(1030,210+round(math.sin(t*.5)*8)),mask)
        d=ImageDraw.Draw(im)
        d.text((94,245),scene['chapter'],font=font(18,'bold'),fill=GOLD)
        title=scene['title'].split('\n')
        for i,line in enumerate(title):
            d.text((88,315+i*108),line,font=font(86,'italic' if i else 'serif'),fill=MINT if i else WHITE)
        if ending:
            d.text((95,625),'STAR GAZER',font=font(32,'bold'),fill=GOLD)
            d.text((95,687),'A project by Michal Novotný',font=font(25),fill=WHITE)
            d.text((95,741),'Places and journeys by Geoapify',font=font(22),fill=MUTED)
            d.text((95,778),'geoapify.com',font=font(25,'bold'),fill=MINT)
            d.text((95,844),'Find the night, the place and the company.',font=font(20),fill=MUTED)
        else:
            d.text((95,610),'A wish becomes a shared experience.',font=font(28),fill=MUTED)
            d.rounded_rectangle((95,690,480,746),radius=28,fill='#203631',outline='#46675a')
            d.text((123,704),'Your stargazing companion',font=font(21),fill=MINT)
    else:
        d.text((80,198),scene['chapter'],font=font(17,'bold'),fill=GOLD)
        y=280
        for i,line in enumerate(scene['title'].split('\n')):
            size=66
            while d.textlength(line,font=font(size,'serif'))>515:size-=1
            d.text((76,y),line,font=font(size,'italic' if i else 'serif'),fill=MINT if i else WHITE)
            y+=88
        d.line((82,y+25,155,y+25),fill=GOLD,width=3)
        wrapped(d,scene['caption'],(80,y+63),470,size=26,color=MUTED,line_height=38)
        if scene.get('note'):
            wrapped(d,scene['note'],(80,818),480,size=18,color=GOLD,line_height=27)
        # Crop to the relevant, real UI; preserve its proportions and text.
        shot=get_footage(scene,local)
        scale=min(1210/shot.width,764/shot.height)
        size=(round(shot.width*scale),round(shot.height*scale))
        shot=shot.resize(size,Image.Resampling.LANCZOS)
        x=650+(1210-size[0])//2;y=156+(764-size[1])//2
        y+=round(math.sin(t*.35)*2)
        shadow=Image.new('RGBA',im.size,(0,0,0,0));sd=ImageDraw.Draw(shadow)
        sd.rounded_rectangle((x-8,y+12,x+size[0]+8,y+size[1]+22),radius=26,fill=(0,0,0,150))
        shadow=shadow.filter(ImageFilter.GaussianBlur(17));im=Image.alpha_composite(im.convert('RGBA'),shadow).convert('RGB')
        mask=Image.new('L',size,0);ImageDraw.Draw(mask).rounded_rectangle((0,0,size[0]-1,size[1]-1),radius=18,fill=255)
        im.paste(shot,(x,y),mask)
        d=ImageDraw.Draw(im)
        d.rounded_rectangle((x,y,x+size[0],y+size[1]),radius=18,outline='#48616a',width=2)
        d.rounded_rectangle((x+18,y-15,x+215,y+16),radius=15,fill='#213c40',outline='#51766e')
        d.text((x+35,y-9),'STAR GAZER',font=font(13,'bold'),fill=MINT)
    return im


def video(segments,preview=False):
    boundaries=[s['at'] for s in SCENES]
    times = [s['at']+s['duration']*.55 for s in SCENES]
    def render(t):
        i=max(0,bisect.bisect_right(boundaries,t)-1);s=SCENES[i];local=t-s['at']
        im=scene_image(s,local,t)
        if i and local<.35:
            prior=SCENES[i-1]
            last=scene_image(prior,prior['duration']-.35+local,t)
            im=Image.blend(last,im,smooth(local/.35))
        d=ImageDraw.Draw(im)
        caption=next((c['text'] for c in segments if c['start']<=t<c['end']),None)
        if caption:
            length=d.textlength(caption,font=font(28))
            x=(W-length)/2
            d.rounded_rectangle((x-28,966,x+length+28,1025),radius=16,fill='#09151f',outline='#2d454c')
            d.text((x,977),caption,font=font(28),fill=WHITE)
        if t<.7:im=Image.blend(Image.new('RGB',im.size,'#050a14'),im,smooth(t/.7))
        if t>TOTAL-1:im=Image.blend(im,Image.new('RGB',im.size,'#050a14'),smooth(t-(TOTAL-1)))
        return im
    for i,t in enumerate(times):
        render(t).save(WORK/f'preview-{i:02}.jpg',quality=91)
    poster=render(SCENES[0]['at']+2.3)
    poster.save(DOCS/'showcase-poster.jpg',quality=95)
    if preview:return
    command=['ffmpeg','-y','-hide_banner','-loglevel','error','-f','rawvideo','-pix_fmt','rgb24','-s',f'{W}x{H}',
             '-r',str(FPS),'-i','-','-an','-c:v','libx264','-preset','fast','-crf','20','-pix_fmt','yuv420p',
             '-threads','6',str(WORK/'picture.mp4')]
    encoder=subprocess.Popen(command,stdin=subprocess.PIPE)
    try:
        for n in range(round(TOTAL*FPS)):
            encoder.stdin.write(render(n/FPS).tobytes())
            if n%(FPS*10)==0:print(f'Picture {n/FPS:.0f}/{TOTAL:.1f}s',flush=True)
    finally:encoder.stdin.close()
    if encoder.wait()!=0:raise RuntimeError('Picture encode failed')
    subprocess.run(['ffmpeg','-y','-hide_banner','-loglevel','error','-i',str(WORK/'picture.mp4'),'-i',str(WORK/'mix.wav'),
                    '-c:v','copy','-af','loudnorm=I=-16:TP=-1.5:LRA=9','-c:a','aac','-b:a','192k','-ar','48000','-t',str(TOTAL),
                    '-movflags','+faststart','-metadata','title=Star Gazer — Look up, together',str(DOCS/'showcase.mp4')],check=True)
    subprocess.run(['ffmpeg','-y','-hide_banner','-loglevel','error','-i',str(WORK/'music.wav'),'-af','loudnorm=I=-18:TP=-1.5:LRA=10',
                    '-c:a','libmp3lame','-q:a','2','-metadata','title=Little Constellations — Star Gazer original theme',str(DOCS/'showcase-music.mp3')],check=True)


if __name__=='__main__':
    parser=argparse.ArgumentParser();parser.add_argument('--preview',action='store_true');args=parser.parse_args()
    segments=original_audio();captions(segments)
    (WORK/'edit.json').write_text(json.dumps([{k:v for k,v in s.items() if k!='audio'} for s in SCENES],indent=2))
    (WORK/'subtitles.json').write_text(json.dumps(segments,indent=2))
    video(segments,args.preview)
    print('Preview ready.' if args.preview else f'Finished docs/showcase.mp4 ({TOTAL:.1f}s).',flush=True)
