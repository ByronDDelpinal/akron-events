import { fetchIcsFeed, parseIcs } from './scripts/lib/ics.js'
const ws = await import('./scripts/scrape-west-side-gymnastics.js')
const wtxt = await fetchIcsFeed('https://calendar.google.com/calendar/ical/westsideoh%40gmail.com/public/basic.ics')
const wraw = parseIcs(wtxt)
const wrows = wraw.map(ws.icsEventToRow).filter(Boolean)
const now=Date.now()
const wfut = wrows.filter(r=>{const s=Date.parse(r.start_at);return s>now-86400000 && s<now+180*86400000})
console.log('WESTSIDE raw',wraw.length,'rows',wrows.length,'inWindow',wfut.length)
for(const r of wfut.slice(0,8)) console.log('  WS', r.start_at,'|',r.title)
// any STATUS:CANCELLED vevents?
console.log('WS STATUS:CANCELLED vevents:', (wtxt.match(/STATUS:CANCELLED/g)||[]).length)
console.log('WS titles containing cancel:', wraw.filter(e=>/cancel/i.test(e.SUMMARY||'')).map(e=>e.SUMMARY).slice(0,5))

// Twinsburg CivicPlus filter over live catID14
const { isPublicCivicPlusEvent } = await import('./scripts/lib/civicplus.js')
const ttxt = await fetchIcsFeed('https://www.mytwinsburg.com/common/modules/iCalendar/iCalendar.aspx?catID=14&feed=calendar')
const traw = parseIcs(ttxt)
const tkeep = traw.filter(e=>isPublicCivicPlusEvent(e.SUMMARY))
console.log('TWINSBURG raw',traw.length,'public',tkeep.length)
for(const e of tkeep.slice(0,12)) console.log('  TW', (e.DTSTART?.value||'').slice(0,8),'|',e.SUMMARY)
console.log('TW dropped sample:', traw.filter(e=>!isPublicCivicPlusEvent(e.SUMMARY)).map(e=>e.SUMMARY).slice(0,6))
