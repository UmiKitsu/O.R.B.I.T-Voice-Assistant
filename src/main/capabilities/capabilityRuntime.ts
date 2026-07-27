import type { ExternalUrlOpener } from '../services/browserService'
import type { ApplicationLauncher } from '../services/applicationDiscoveryService'
import type { AudioMuteController, MediaKeySender } from '../services/mediaControlService'
import type { WindowController } from '../services/windowInputService'
import { ConfirmationManager } from '../security/confirmationManager'
import { PolicyEngine } from '../security/policyEngine'
import { registerAssistantCapabilities } from './assistantCapabilities'
import { registerApplicationCapabilities } from './applicationCapabilities'
import { registerBrowserCapabilities } from './browserCapabilities'
import { CapabilityRegistry } from './capabilityRegistry'
import { registerMediaCapabilities } from './mediaCapabilities'
import { registerSystemCapabilities } from './systemCapabilities'
import { registerWindowInputCapabilities } from './windowInputCapabilityDefinitions'
import { getSettings } from '../services/settingsService'

export type CapabilityRuntimeDependencies = {
  now?: () => Date
  openExternalUrl?: ExternalUrlOpener
  sendMediaKey?: MediaKeySender
  setAudioMuted?: AudioMuteController
  launchApplication?: ApplicationLauncher
  windowController?: WindowController
}

export function createCapabilityRegistry(
  dependencies: CapabilityRuntimeDependencies = {}
): CapabilityRegistry {
  const registry = new CapabilityRegistry()
  registerSystemCapabilities(registry, dependencies.now)
  registerBrowserCapabilities(registry, dependencies.openExternalUrl)
  registerMediaCapabilities(registry, dependencies.sendMediaKey, dependencies.setAudioMuted)
  registerApplicationCapabilities(registry, dependencies.launchApplication)
  registerAssistantCapabilities(registry)
  registerWindowInputCapabilities(registry, dependencies.windowController)

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
