/**
 * kittens.ts
 *
 * The kitten break's photo roster, names, and caption lines. Photos are
 * static files in public/kittens/ (referenced by URL only, never imported,
 * so zero bytes of any JS chunk carry a kitten). Every photo is a real
 * photograph by a human photographer on Wikimedia Commons, and the visible
 * credit link under the photo is a license requirement, not a nicety --
 * always render it.
 *
 * Credits transcribed from the source drop's credits.json; if a photo is
 * ever swapped, its credit line changes in the same commit.
 */

export interface KittenPhoto {
  /** File name under /kittens/. */
  file: string
  /** Link text for the credit line. */
  credit: string
  /** The photo's file page on Wikimedia Commons. */
  url: string
}

export const KITTEN_PHOTOS: readonly KittenPhoto[] = [
  { file: 'kitten-01.jpg', credit: 'Six weeks old kitten', url: 'https://commons.wikimedia.org/wiki/File:Six_weeks_old_cat_(aka).jpg' },
  { file: 'kitten-02.jpg', credit: 'Cute kitten', url: 'https://commons.wikimedia.org/wiki/File:Cute_kitten.jpg' },
  { file: 'kitten-03.jpg', credit: 'Young kitten', url: 'https://commons.wikimedia.org/wiki/File:Youngkitten.JPG' },
  { file: 'kitten-04.jpg', credit: 'Sphynx kittens', url: 'https://commons.wikimedia.org/wiki/File:Cat_Sphynx._Kittens._img_11.jpg' },
  { file: 'kitten-05.jpg', credit: 'Cat on snow', url: 'https://commons.wikimedia.org/wiki/File:Felis_catus-cat_on_snow.jpg' },
  { file: 'kitten-06.jpg', credit: 'Exploring kitten', url: 'https://commons.wikimedia.org/wiki/File:Exploring_kitten.jpg' },
  { file: 'kitten-07.jpg', credit: 'Tiny kitten', url: 'https://commons.wikimedia.org/wiki/File:Tiny_Kitten.jpg' },
  { file: 'kitten-08.jpg', credit: 'Persian kitten', url: 'https://commons.wikimedia.org/wiki/File:Persian_Cat_(kitten).jpg' },
  { file: 'kitten-09.jpg', credit: 'Holding a kitten', url: 'https://commons.wikimedia.org/wiki/File:Holding_a_Kitten.jpg' },
  { file: 'kitten-10.jpg', credit: 'Red kitten', url: 'https://commons.wikimedia.org/wiki/File:Red_Kitten_01.jpg' },
  { file: 'kitten-11.jpg', credit: 'Cat sleeping with kitten', url: 'https://commons.wikimedia.org/wiki/File:Cute_Cat_Sleeping_with_Kitten.jpg' },
  { file: 'kitten-12.jpg', credit: 'Sleeping kitten', url: 'https://commons.wikimedia.org/wiki/File:Another_sleeping_kitten_-b.jpg' },
  { file: 'kitten-13.jpg', credit: 'Sleeping cat', url: 'https://commons.wikimedia.org/wiki/File:Sleeping_Cat.png' },
  { file: 'kitten-14.jpg', credit: 'White cat on a bench', url: 'https://commons.wikimedia.org/wiki/File:White_cat_sleeping_on_a_bench.jpg' },
]

export const KITTEN_NAMES: readonly string[] = [
  'Biscuit', 'Waffles', 'Beans', 'Mochi', 'Pretzel', 'Pierogi',
  'Noodle', 'Tater Tot', 'Dumpling', 'Clementine', 'Marbles', 'Zucchini',
]

export const KITTEN_LINES: readonly string[] = [
  'is rooting for you.',
  'says the queue can wait a minute.',
  'approves of your triage pace.',
  'has zero events that need review.',
  'thinks you have earned a stretch.',
  'is on moderation hold for being too cute.',
]

/** URL for a photo, servable straight from public/. */
export function kittenSrc(photo: KittenPhoto): string {
  return `/kittens/${photo.file}`
}

/**
 * Pick the next photo index, never repeating the previous one (there is
 * more than one kitten; showing the same one twice reads as a bug).
 */
export function pickKittenIndex(previous: number | null): number {
  if (KITTEN_PHOTOS.length <= 1) return 0
  let i: number
  do {
    i = Math.floor(Math.random() * KITTEN_PHOTOS.length)
  } while (i === previous)
  return i
}

/** A random cute name plus caption line for one press. */
export function pickKittenCaption(): { name: string; line: string } {
  return {
    name: KITTEN_NAMES[Math.floor(Math.random() * KITTEN_NAMES.length)],
    line: KITTEN_LINES[Math.floor(Math.random() * KITTEN_LINES.length)],
  }
}
