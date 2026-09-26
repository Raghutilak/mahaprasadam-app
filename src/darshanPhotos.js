
const GITHUB_RAW =
  "https://raw.githubusercontent.com/Raghutilak/e-darshan/main";

export const DARSHAN_PHOTOS = {
  mangala: [
    `${GITHUB_RAW}/mangala-1.jpg`,
    `${GITHUB_RAW}/mangala-2.jpg`,
    `${GITHUB_RAW}/mangala-3.jpg`,
  ],

  sringar: [
    `${GITHUB_RAW}/sringar-1.jpg`,
    `${GITHUB_RAW}/sringar-2.jpg`,
    `${GITHUB_RAW}/sringar-3.jpg`,
  ],
};

/*
 * Adds a cache-busting value so the browser/CDN
 * doesn't keep showing yesterday's image.
 */
export function getDarshanPhotos(type) {
  const today = new Date().toISOString().slice(0, 10);

  return DARSHAN_PHOTOS[type].map(
    (url) => `${url}?v=${today}`
  );
}

