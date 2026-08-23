import { Composition } from 'remotion'
import { PhoneVideo, VIDEO_FPS, VIDEO_DURATION_IN_SECONDS } from './PhoneVideo'

export const RemotionRoot = () => {
  return (
    <Composition
      id="PhoneVideo"
      component={PhoneVideo}
      durationInFrames={VIDEO_DURATION_IN_SECONDS * VIDEO_FPS}
      fps={VIDEO_FPS}
      width={1080}
      height={1920}
    />
  )
}
