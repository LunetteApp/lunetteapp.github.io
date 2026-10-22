// Set the listing URL and enable this flag when the Android app is available.
const GOOGLE_PLAY_ENABLED = false;
const GOOGLE_PLAY_URL = 'GOOGLE_PLAY_URL_PLACEHOLDER';

(() => {
    const appStoreLink = document.getElementById('app-store-link');
    const googlePlayLink = document.getElementById('google-play-link');
    const status = document.getElementById('download-status');
    const googlePlayAvailable = GOOGLE_PLAY_ENABLED
        && GOOGLE_PLAY_URL !== 'GOOGLE_PLAY_URL_PLACEHOLDER';

    if (googlePlayAvailable) {
        googlePlayLink.href = GOOGLE_PLAY_URL;
        googlePlayLink.hidden = false;
        status.textContent = 'Choose your store to get Lunette.';
    }

    const userAgent = navigator.userAgent || '';
    const platform = navigator.userAgentData?.platform || navigator.platform || '';
    // iPad Safari can identify itself as a Mac when requesting desktop websites.
    const isIOS = /iPhone|iPad|iPod/i.test(userAgent)
        || (/Mac/i.test(platform) && navigator.maxTouchPoints > 1);
    const isAndroid = /Android/i.test(userAgent) || /Android/i.test(platform);

    let destination;
    if (isIOS) {
        status.textContent = 'Opening the App Store…';
        destination = appStoreLink.href;
    } else if (isAndroid && googlePlayAvailable) {
        status.textContent = 'Opening Google Play…';
        destination = googlePlayLink.href;
    }

    if (destination) {
        // Keep the store buttons available if the browser blocks navigation.
        try {
            window.location.replace(destination);
        } catch {
            status.textContent = googlePlayAvailable
                ? 'Choose your store to get Lunette.'
                : 'Get Lunette for iPhone.';
        }
    }
})();
