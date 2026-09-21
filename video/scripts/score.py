"""Original deterministic ambient score. No samples or third-party music."""
import math, random, wave, struct
from pathlib import Path
sr=48000; duration=30; rng=random.Random(41)
out=[0.0]*(sr*duration)
def note(t,d,hz,amp):
    start=int(t*sr)
    for j in range(min(int(d*sr),len(out)-start)):
        x=j/sr; env=min(1,x/.035)*math.exp(-x/(d*.3))*min(1,(d-x)/.2)
        out[start+j]+=amp*env*(math.sin(2*math.pi*hz*x)+.22*math.sin(2*math.pi*hz*2*x))
# Restrained A-minor arpeggios, opening tension, lift, resolved final chord.
chords=[[220,261.626,329.628],[174.614,220,261.626],[130.813,164.814,195.998],[195.998,246.942,293.665]]
for beat in range(56):
    t=beat*.5
    chord=chords[(beat//12)%4]
    note(t,1.65,chord[beat%3]*(2 if beat%4==3 else 1),.065)
for t in [0,4,9.5,15,21,26]:
    note(t,3.5,55,.17)
    for j in range(int(.22*sr)):
        x=j/sr
        out[int(t*sr)+j]+=.14*math.exp(-x*26)*math.sin(2*math.pi*(85*x-85*x*x))
for t in [4,9.5,15,21,26]:
    start=int((t-.4)*sr)
    for j in range(int(.8*sr)):
        x=j/sr; env=math.sin(math.pi*x/.8)**3
        out[start+j]+=(rng.random()*2-1)*.026*env
for hz in [110,220,261.626,329.628,440]: note(26,4,hz,.055)
for t in [4.47,5.33,16,16.77]:
    note(t,.35,880,.065);note(t+.055,.4,1320,.035)
peak=max(abs(x) for x in out)
path=Path(__file__).resolve().parent.parent/'public/launch-score.wav'
with wave.open(str(path),'wb') as w:
    w.setnchannels(2);w.setsampwidth(2);w.setframerate(sr)
    data=bytearray()
    for i,x in enumerate(out):
        fade=min(1,i/(sr*.04),(len(out)-i)/(sr*.8))
        v=int(x/peak*.75*fade*32767)
        data.extend(struct.pack('<hh',v,v))
    w.writeframes(data)
print(path)
