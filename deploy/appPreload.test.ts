import { expect, it } from 'bun:test'
import { appScreenChunk } from './appPreload'
it('preloads only the selected screen and separates persona homes', () => {
  expect(appScreenChunk('/app')).toBe('src/platform/SettingsSheet.tsx')
  expect(appScreenChunk('/app/mini/friend/home')).toBe('src/platform/HomeApp.tsx')
  expect(appScreenChunk('/app/mini/cofounder/apps')).toBe('src/platform/WorkHomes.tsx')
  expect(appScreenChunk('/app/mini/friend/later')).toBe('src/platform/FriendHubApps.tsx')
  expect(appScreenChunk('/app/mini/friend/weekly_focus/')).toBe('src/platform/LifeMiniApps.tsx')
  expect(appScreenChunk('/app/mini/friend/nutrition')).toBe('src/platform/FeatureMiniApps.tsx')
  expect(appScreenChunk('/app/login')).toBeNull()
  expect(appScreenChunk('/app/mini/friend/unknown')).toBeNull()
  expect(appScreenChunk('/')).toBeNull()
})
