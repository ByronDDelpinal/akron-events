/**Fixture data for Akron Civic Theatre scraper tests.*/
export const SINGLE_DATE = { raw: 'March 15, 2026', expectedDate: '2026-03-15' }
export const MONTH_RANGE = { raw: 'March 15 - April 5, 2026', expectedStart: '2026-03-15', expectedEnd: '2026-04-05' }
export const SINGLE_DAY_RANGE = { raw: 'May 10 - 12, 2026', expectedStart: '2026-05-10', expectedEnd: '2026-05-12' }
export const TIME_EXTRACTION = { raw: '7:30 PM', expectedTime: '7:30 pm' }
export const ALL_FIXTURES = [SINGLE_DATE, MONTH_RANGE, SINGLE_DAY_RANGE, TIME_EXTRACTION]
