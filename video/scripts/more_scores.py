"""Two original synthesized soundtracks. No external samples."""
import math, random, struct, wave
from pathlib import Path
SR=48000
ROOT=Path(__file__).resolve().parent.parent/'public'
def create(name,bright):
    buf=[0.]*(30*SR);rng=random.Random(24)
    def tone(t,d,hz,amp,soft=False):
        start=int(t*SR)
        for j in range(min(int(d*SR),len(buf)-start)):
            x=j/SR
            env=min(1,x/(.015 if bright else .06))*math.exp(-x/(d*.35))*min(1,(d-x)/.08)
            v=math.sin(2*math.pi*hz*x)+(.12 if soft else .25)*math.sin(2*math.pi*hz*2*x)
            buf[start+j]+=v*amp*env
    notes=[261.626,329.628,391.995,493.883] if bright else [110,130.813,164.814,195.998]
    step=.5 if bright else .375
    for b in range(int(28/step)):
        tone(b*step,1.2 if bright else 1.8,notes[b%4]*(1 if bright else 2),.055,bright)
        if b%4==0:tone(b*step,1.5,notes[(b//16)%4]/(2 if bright else 1),.065)
    cuts=[0,4,11,18,24] if bright else [0,3.5,7,13,19,25]
    for t in cuts:
        tone(t,2,65 if bright else 48,.10)
        if not bright:
            for j in range(int(.2*SR)):
                x=j/SR;buf[int(t*SR)+j]+=.15*math.exp(-x*25)*math.sin(2*math.pi*(90*x-150*x*x))
        if t>0:
            for j in range(int(.5*SR)):
                x=j/SR;buf[int((t-.25)*SR)+j]+=(rng.random()*2-1)*.016*math.sin(math.pi*x/.5)**3
    for t in ([4.2,5.1,11.1,12,12.6] if bright else [7.2,8,13.1,14]):
        tone(t,.3,880,.035,True);tone(t+.07,.4,1318.51,.025,True)
    for hz in notes:tone(25 if not bright else 24,5,hz,.07,True)
    peak=max(abs(x) for x in buf)
    data=bytearray()
    for i,x in enumerate(buf):
        fade=min(1,i/(SR*.03),(len(buf)-i)/(SR*1.2))
        v=int(x/peak*.65*fade*32767);data.extend(struct.pack('<hh',v,v))
    with wave.open(str(ROOT/name),'wb') as w:
        w.setnchannels(2);w.setsampwidth(2);w.setframerate(SR);w.writeframes(data)
    print(name)
create('midnight-score.wav',False)
create('conversation-score.wav',True)
