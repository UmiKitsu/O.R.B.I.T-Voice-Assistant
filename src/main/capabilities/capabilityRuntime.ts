import type { ApplicationLauncher } from '../services/applicationDiscoveryService'
import type { ExternalUrlOpener } from '../services/browserService'
import type {
  AudioMuteController,
  AudioVolumeController,
  MediaKeySender
} from '../services/mediaControlService'
import type { SpotifyPlaybackController } from '../services/spotifyService'
import type { SpotifyWebApiDependencies } from '../services/spotifyWebApiService'
import type { WindowController } from '../services/windowInputService'
import type { TrashController } from '../services/filesystemService'
import type { InstallerLauncher } from '../services/softwareInstallService'
import { ConfirmationManager } from '../security/confirmationManager'
import { PolicyEngine } from '../security/policyEngine'
import { getSettings } from '../services/settingsService'
import { registerApplicationCapabilities } from './applicationCapabilities'
import { registerAssistantCapabilities } from './assistantCapabilities'
import { registerBrowserCapabilities } from './browserCapabilities'
import { CapabilityRegistry } from './capabilityRegistry'
import { registerMediaCapabilities } from './mediaCapabilities'
import { registerFilesystemCapabilities } from './filesystemCapabilities'
import { registerSoftwareCapabilities } from './softwareCapabilities'
import { registerSpotifyCapabilities } from './spotifyCapabilities'
import { registerSystemCapabilities } from './systemCapabilities'
import { registerWindowInputCapabilities } from './windowInputCapabilityDefinitions'

export type CapabilityRuntimeDependencies = {
  now?: () => Date
  openExternalUrl?: ExternalUrlOpener
  sendMediaKey?: MediaKeySender
  setAudioMuted?: AudioMuteController
  setAudioVolume?: AudioVolumeController
  launchApplication?: ApplicationLauncher
  windowController?: WindowController
  spotifyController?: SpotifyPlaybackController
  spotifyDelay?: (milliseconds: number) => Promise<void>
  spotifyNow?: () => number
  spotifyWebApi?: SpotifyWebApiDependencies
  trashController?: TrashController
  installerLauncher?: InstallerLauncher
}

export function createCapabilityRegistry(
  dependencies: CapabilityRuntimeDependencies = {}
): CapabilityRegistry {
  const registry = new CapabilityRegistry()
  registerSystemCapabilities(registry, dependencies.now)
  registerBrowserCapabilities(registry, dependencies.openExternalUrl)
  registerMediaCapabilities(
    registry,
    dependencies.sendMediaKey,
    dependencies.setAudioMuted,
    dependencies.setAudioVolume
  )
  registerApplicationCapabilities(registry, dependencies.launchApplication)
  registerSpotifyCapabilities(registry, {
    controller: dependencies.spotifyController,
    launcher: dependencies.launchApplication,
    delay: dependencies.spotifyDelay,
    now: dependencies.spotifyNow,
    openExternalUrl: dependencies.openExternalUrl,
    webApi: dependencies.spotifyWebApi
  })
  registerAssistantCapabilities(registry)
  registerWindowInputCapabilities(registry, dependencies.windowController)
  registerFilesystemCapabilities(registry, dependencies.trashController)
  registerSoftwareCapabilities(registry, dependencies.installerLauncher)

  return registry
}

export function createCapabilityRuntime(
  dependencies: CapabilityRuntimeDependencies = {},
  registry: CapabilityRegistry = createCapabilityRegistry(dependencies)
): PolicyEngine {
  return new PolicyEngine(
    registry,
    new ConfirmationManager(),
    () => getSettings().confirmationTimeoutSeconds * 1_000
  )
}
