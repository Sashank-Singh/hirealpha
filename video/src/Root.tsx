import { LaunchFilm } from './LaunchFilm'
import { Composition } from 'remotion'
import { PhoneVideo, VIDEO_FPS, VIDEO_DURATION_IN_SECONDS } from './PhoneVideo'

export const RemotionRoot = () => {
  return (
    <>
    <Composition id="HireAlphaLaunch" component={LaunchFilm} durationInFrames={900} fps={30} width={1920} height={1080} />
    <Composition
      id="PhoneVideo"
      component={PhoneVideo}
      durationInFrames={VIDEO_DURATION_IN_SECONDS * VIDEO_FPS}
      fps={VIDEO_FPS}
      width={1080}
      height={1920}
    />
    </>
  )
}
