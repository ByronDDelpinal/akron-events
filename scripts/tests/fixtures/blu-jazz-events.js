/**
 * Fixture data for BLU Jazz+ scraper tests.
 * TurnTable Tickets HTML card parsing.
 */

export const COMPLETE_EVENT = {
  cardHtml: `
    <div id="show-42-2026-05-15" class="show-card">
      <h3>The Jazz Collective</h3>
      <p>Friday, May 15, 2026</p>
      <p>Doors: 7:00pm</p>
      <p>Show: 8:00pm</p>
      <p>$20 in advance, $25 at the door</p>
      <img src="https://assets-prod.turntabletickets.com/media/blu-jazz/jazz-collective.jpg" />
    </div>
  `,
  expectedShowId: '42',
  expectedShowDate: '2026-05-15',
  expectedTitle: 'The Jazz Collective',
  expectedShowTime: '8:00pm',
  expectedDoorsTime: '7:00pm',
  expectedPriceMin: 20,
  expectedPriceMax: 25,
  expectedImageUrl: 'https://assets-prod.turntabletickets.com/media/blu-jazz/jazz-collective.jpg',
}

export const FREE_ADMISSION = {
  cardHtml: `
    <div id="show-1-2026-04-10" class="show-card">
      <h3>Open Mic Night</h3>
      <p>Friday, April 10, 2026</p>
      <p>Doors: 6:00pm</p>
      <p>Show: 7:00pm</p>
      <p>Free admission, donation appreciated</p>
      <img src="https://assets-prod.turntabletickets.com/media/blu-jazz/open-mic.png" />
    </div>
  `,
  expectedShowId: '1',
  expectedShowDate: '2026-04-10',
  expectedTitle: 'Open Mic Night',
  expectedPriceMin: 0,
  expectedPriceMax: 0,
}

export const NO_COVER_CHARGE = {
  cardHtml: `
    <div id="show-99-2026-06-01" class="show-card">
      <h3>Local Legends Jam</h3>
      <p>Monday, June 01, 2026</p>
      <p>No cover charge</p>
      <p>8:30pm - 10:30pm</p>
      <img src="https://assets-prod.turntabletickets.com/media/blu-jazz/legends.jpg" />
    </div>
  `,
  expectedShowId: '99',
  expectedShowDate: '2026-06-01',
  expectedPriceMin: 0,
  expectedPriceMax: 0,
}

export const SINGLE_PRICE = {
  cardHtml: `
    <div id="show-55-2026-07-12" class="show-card">
      <h3>Saturday Night Special</h3>
      <p>Saturday, July 12, 2026</p>
      <p>Doors: 7:30pm, Show: 8:30pm</p>
      <p>$30 per person</p>
    </div>
  `,
  expectedShowId: '55',
  expectedShowDate: '2026-07-12',
  expectedPriceMin: 30,
  expectedPriceMax: 30,
}

export const MISSING_SHOW_TIME = {
  cardHtml: `
    <div id="show-77-2026-08-05" class="show-card">
      <h3>Acoustic Evening</h3>
      <p>Wednesday, August 05, 2026</p>
      <p>$15</p>
      <img src="https://assets-prod.turntabletickets.com/media/blu-jazz/acoustic.jpg" />
    </div>
  `,
  expectedShowId: '77',
  expectedShowDate: '2026-08-05',
  expectedShowTime: null,
  expectedPriceMin: 15,
  expectedPriceMax: 15,
}

export const MISSING_ID = {
  cardHtml: `
    <div class="show-card">
      <h3>No ID Event</h3>
      <p>Friday, May 20, 2026</p>
      <p>$20</p>
    </div>
  `,
  shouldReturnNull: true,
}

export const MISSING_TITLE = {
  cardHtml: `
    <div id="show-88-2026-05-25" class="show-card">
      <p>Friday, May 25, 2026</p>
      <p>8:00pm, $20</p>
    </div>
  `,
  shouldReturnNull: true,
}

export const HTML_ENTITIES_IN_TITLE = {
  cardHtml: `
    <div id="show-33-2026-06-15" class="show-card">
      <h3>The &quot;Blue&quot; Jazz Ensemble &amp; Friends</h3>
      <p>Monday, June 15, 2026</p>
      <p>Doors: 7:00pm, Show: 8:00pm</p>
      <p>$18</p>
      <img src="https://assets-prod.turntabletickets.com/media/blu-jazz/ensemble.jpg" />
    </div>
  `,
  expectedTitle: 'The "Blue" Jazz Ensemble & Friends',
}

export const PRICE_RANGE_VARIATIONS = {
  cardHtml: `
    <div id="show-44-2026-07-20" class="show-card">
      <h3>Summer Jazz Series</h3>
      <p>Tuesday, July 20, 2026</p>
      <p>Show: 9:00pm</p>
      <p>$25 advance, $30 door</p>
      <img src="https://assets-prod.turntabletickets.com/media/blu-jazz/summer.jpg" />
    </div>
  `,
  expectedPriceMin: 25,
  expectedPriceMax: 30,
}

export const ONLY_DOORS_TIME = {
  cardHtml: `
    <div id="show-66-2026-08-10" class="show-card">
      <h3>Late Night Session</h3>
      <p>Sunday, August 10, 2026</p>
      <p>Doors: 10:00pm</p>
      <p>$12</p>
    </div>
  `,
  expectedShowId: '66',
  expectedDoorsTime: '10:00pm',
  expectedShowTime: null,
}

export const NO_IMAGE = {
  cardHtml: `
    <div id="show-11-2026-09-05" class="show-card">
      <h3>Intimate Concert</h3>
      <p>Saturday, September 05, 2026</p>
      <p>Show: 7:30pm</p>
      <p>$22</p>
    </div>
  `,
  expectedImageUrl: null,
}

export const WEBP_IMAGE = {
  cardHtml: `
    <div id="show-22-2026-05-10" class="show-card">
      <h3>Digital Era Jazz</h3>
      <p>Thursday, May 10, 2026</p>
      <p>Doors: 7:00pm, Show: 8:00pm</p>
      <p>$19</p>
      <img src="https://assets-prod.turntabletickets.com/media/blu-jazz/digital.webp" />
    </div>
  `,
  expectedImageUrl: 'https://assets-prod.turntabletickets.com/media/blu-jazz/digital.webp',
}

export const LONG_DESCRIPTION_TEXT = {
  cardHtml: `
    <div id="show-100-2026-06-22" class="show-card">
      <h3>International Jazz Legends</h3>
      <p>Tuesday, June 22, 2026</p>
      <p>A special evening featuring world-renowned jazz musicians from across the globe. This is a very long description that contains lots of details about the performers and what to expect at the show.</p>
      <p>Doors: 7:00pm, Show: 8:00pm</p>
      <p>$35 in advance, $40 at door</p>
    </div>
  `,
  expectedPriceMin: 35,
  expectedPriceMax: 40,
}

export const ALL_FIXTURES = [
  COMPLETE_EVENT,
  FREE_ADMISSION,
  NO_COVER_CHARGE,
  SINGLE_PRICE,
  MISSING_SHOW_TIME,
  MISSING_ID,
  MISSING_TITLE,
  HTML_ENTITIES_IN_TITLE,
  PRICE_RANGE_VARIATIONS,
  ONLY_DOORS_TIME,
  NO_IMAGE,
  WEBP_IMAGE,
  LONG_DESCRIPTION_TEXT,
]
