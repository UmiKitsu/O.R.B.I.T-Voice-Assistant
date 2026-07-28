export const ORBIT_APP_ID = 'com.umikitsune.orbit' as const
export const ORBIT_PACKAGE_NAME = 'orbit-voice-assistant' as const
export const ORBIT_BROWSER_PAIRING_FILE_NAME = 'orbit-browser-pairing.bin' as const

export const ORBIT_BROWSER_EXTENSION_PUBLIC_KEY =
  'MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEA56Ewfk1O2Q5A2sCXm93rmB42rKZVKxOw6v9sppzQ3wu+IRCtwXhgu+76I+XN2y6G++zVBWWbUV42icoRzGFpLWk0I5BBx6gfOtAsnHzYWoB/NvK/f2bp5FK32G/UeNS9bg2pSJCShOBcIQft2DFP6wToKJwsZg/kbKhCDOh1qz9LU9FryJO36vRfbTh8KC9+fFtrPJOB/rlrsY3GJSiLsUMtAnqhgmpJ5AkUboCFxqLK1QTvhEidEPzjPDH/nGzqtvj4pALEauHAPlINWaJCcsgvs1WiszI3WqflZPRV2wHnrd0Mjt3aQwUHz55ZrkX2DzO2VfaC+Svacm5Eou1ykQIDAQAB' as const
export const ORBIT_BROWSER_EXTENSION_ID = 'bpnhommpdnofjjgbgjoehmdjglfglkje' as const
export const ORBIT_BROWSER_EXTENSION_ORIGIN =
  `chrome-extension://${ORBIT_BROWSER_EXTENSION_ID}` as const

// These identifiers define where existing encrypted browser pairing data lives.
// A future rename must migrate the old userData record before changing any of them.
export const ORBIT_BROWSER_PAIRING_COMPATIBILITY = Object.freeze({
  appId: ORBIT_APP_ID,
  packageName: ORBIT_PACKAGE_NAME,
  pairingFileName: ORBIT_BROWSER_PAIRING_FILE_NAME
})
