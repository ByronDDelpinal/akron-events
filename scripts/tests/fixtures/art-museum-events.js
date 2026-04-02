/**Fixture data for Akron Art Museum scraper tests.*/
export const COMPLETE_PARSED_DATETIME = {
  rawText: 'Tuesday, March 24, 20261:00 – 4:00 pm',
  expectedDate: '2026-03-24',
  expectedStart: '1:00 pm',
  expectedEnd: '4:00 pm',
}

export const TIME_RANGE_NO_AMPM_START = {
  rawText: 'Friday, April 4, 202610:00 am – 12:00 pm',
  expectedDate: '2026-04-04',
  expectedStart: '10:00 am',
  expectedEnd: '12:00 pm',
}

export const ALL_DAY_EVENT = {
  rawText: 'Saturday, May 10, 2026All day',
  expectedDate: '2026-05-10',
  expectedAllDay: true,
}

export const SINGLE_TIME_ONLY = {
  rawText: 'Wednesday, June 15, 20267:00 pm',
  expectedDate: '2026-06-15',
  expectedStart: '7:00 pm',
  expectedEnd: null,
}

export const INVALID_DATE = {
  rawText: 'Invalid date format here',
  expectedResult: null,
}

export const ALL_FIXTURES = [
  COMPLETE_PARSED_DATETIME,
  TIME_RANGE_NO_AMPM_START,
  ALL_DAY_EVENT,
  SINGLE_TIME_ONLY,
  INVALID_DATE,
]
