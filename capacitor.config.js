/** @type {import('@capacitor/cli').CapacitorConfig} */
const config = {
  appId: 'com.caseflow.app',
  appName: 'CaseArc',
  webDir: 'www',
  bundledWebRuntime: false,

  server: {
    hostname: 'caseflow.app',
    androidScheme: 'https',
  },

  ios: {
    contentInset: 'never',
    backgroundColor: '#07090f',
    allowsLinkPreview: false,
    scrollEnabled: false,
    limitsNavigationsToAppBoundDomains: false,
  },

  plugins: {
    SplashScreen: {
      launchShowDuration: 1200,
      launchAutoHide: true,
      backgroundColor: '#07090f',
      androidSplashResourceName: 'splash',
      androidScaleType: 'CENTER_CROP',
      showSpinner: false,
      splashFullScreen: true,
      splashImmersive: true,
    },
    StatusBar: {
      style: 'dark',
      backgroundColor: '#07090f',
      overlaysWebView: true,
    },
    Keyboard: {
      resize: 'body',
      style: 'dark',
      resizeOnFullScreen: true,
    },
  },
};

module.exports = config;
