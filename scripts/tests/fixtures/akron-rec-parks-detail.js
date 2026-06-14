/**
 * Fixtures for the Akron Rec & Parks (RecDesk) Detail-page parser.
 *
 * Mirrors the real structure of
 *   https://akron.recdesk.com/Community/Program/Detail?programId=2002
 * captured 2026-06-14: an og:description meta (with HTML entities), a
 * #program-fees section containing the Standard Fee table FOLLOWED BY a
 * separate Addon Fees table, and a #program-schedule table whose rows carry
 * data-label cells. The Standard table has one open ($300) row and two
 * membership-gated discount rows ($25, $210); the parser must report the
 * public price ($300) and ignore the addon ($100) amounts entirely.
 */

export const DETAIL_HTML = `<!doctype html><html><head>
<meta property="og:title" content="8 Week Summer Fun Camp" />
<meta property="og:description" content="The Lawton Street 8-Week Summer Fun Camp keeps campers engaged &amp; learning all summer. Campers&#39; trips include the Akron Zoo. The $300 camp fee includes a T-shirt, field trips &amp; meals." />
</head><body>
<h1>Lawton St. CC - 8 Week Summer Fun Camp</h1>
<div id="program-detail" class="tab-pane">
  <div class="well">Body copy version of the description with a<br>line break.</div>
</div>
<div id="program-fees" class="tab-pane fade">
  <table class="table table-reflow"><caption class="sr-only">Program Fees</caption>
    <thead><tr class="sub-category-header"><th scope="col">Standard Fee</th><th scope="col">Residency Restriction</th><th scope="col">Membership Restrictions</th><th scope="col">Amount</th></tr></thead>
    <tbody>
      <tr><th scope="row" data-label="Standard Fee">Summer Camp - 8 week</th><td data-label="Residency Restriction">-None-</td><td data-label="Membership Restrictions"><div class="membership-list"><span>-None-</span></div></td><td data-label="Amount">$300.00</td></tr>
      <tr><th scope="row" data-label="Standard Fee">AMHA - Summer Camp</th><td data-label="Residency Restriction">-None-</td><td data-label="Membership Restrictions"><div class="membership-list"><a class="btn-link" href="/Community/Membership/Detail?membershipId=1984">AMHA Summer Camps 2026</a></div></td><td data-label="Amount">$25.00</td></tr>
      <tr><th scope="row" data-label="Standard Fee">YES Fund 30%</th><td data-label="Residency Restriction">-None-</td><td data-label="Membership Restrictions"><div class="membership-list"><a class="btn-link" href="/Community/Membership/Detail?membershipId=1919">2026 YES Fund</a></div></td><td data-label="Amount">$210.00</td></tr>
    </tbody>
  </table>
  <table class="table table-reflow"><caption class="sr-only">Addon Fees</caption>
    <thead><tr><th scope="col">Add On Fee</th><th scope="col">Residency Restriction</th><th scope="col">Amount</th></tr></thead>
    <tbody>
      <tr><th scope="row" data-label="Add On Fee">After Care</th><td data-label="Residency Restriction">-None-</td><td data-label="Amount">$100.00</td></tr>
      <tr><th scope="row" data-label="Add On Fee">Before Care</th><td data-label="Residency Restriction">-None-</td><td data-label="Amount">$100.00</td></tr>
    </tbody>
  </table>
</div>
<div id="program-schedule" class="tab-pane fade">
  <table class="table table-vcenter no-border"><caption class="sr-only">Program Schedule</caption>
    <thead><tr><th scope="col">Date</th><th scope="col">Day</th><th scope="col">Start Time</th><th scope="col">End Time</th><th scope="col">Location</th></tr></thead>
    <tbody>
      <tr><th data-label="Date" scope="row">06/08/2026</th><td data-label="Day">Monday</td><td data-label="Start Time">9:00 AM</td><td data-label="End Time">3:00 PM</td><td data-label="Location"><a class="btn-link" href="/Community/Facility/Detail?facilityId=9">Lawton Street Community Center</a></td></tr>
      <tr><th data-label="Date" scope="row">06/09/2026</th><td data-label="Day">Tuesday</td><td data-label="Start Time">9:00 AM</td><td data-label="End Time">3:00 PM</td><td data-label="Location"><a class="btn-link" href="/Community/Facility/Detail?facilityId=9">Lawton Street Community Center</a></td></tr>
      <tr><th data-label="Date" scope="row">07/31/2026</th><td data-label="Day">Friday</td><td data-label="Start Time">9:00 AM</td><td data-label="End Time">3:00 PM</td><td data-label="Location"><a class="btn-link" href="/Community/Facility/Detail?facilityId=9">Lawton Street Community Center</a></td></tr>
    </tbody>
  </table>
</div>
</body></html>`

// A program with a description but NO fees table and NO schedule table — the
// parser must degrade to { fees:{null}, schedule:null } and still return text.
export const DETAIL_HTML_MINIMAL = `<!doctype html><html><head>
<meta property="og:description" content="A simple one-day workshop." />
</head><body>
<div id="program-detail"><div class="well">A simple one-day workshop.</div></div>
</body></html>`

// No og:description at all — parser falls back to the body .well block.
export const DETAIL_HTML_WELL_ONLY = `<!doctype html><html><head></head><body>
<div id="program-detail"><div class="well">Well-only copy here.<br>Second line.</div></div>
</body></html>`
