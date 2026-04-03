/**Fixture data for Ticketmaster API scraper tests.*/
export const F1 = { prices: [{ type: 'standard', min: 25.5, max: 95.0 }], expMin: 25.5, expMax: 95.0 }
export const F2 = { prices: [], expMin: null, expMax: null }
export const F3 = { classifications: [{ segment: { name: 'Music' }, genre: { name: 'Rock' } }], expCat: 'music' }
export const F4 = { classifications: [{ segment: { name: 'Sports' } }], expCat: 'sports' }
export const ALL = [F1, F2, F3, F4]
