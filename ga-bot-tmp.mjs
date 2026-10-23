import 'dotenv/config'
import { loadConfig, mintJwt, usOnly } from './scripts/ga-snapshot.js'
const cfg = loadConfig()
const tok = await (await fetch('https://oauth2.googleapis.com/token',{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams({grant_type:'urn:ietf:params:oauth:grant-type:jwt-bearer',assertion:mintJwt(cfg.sa)})})).json()
async function rep(dims, start, end, us, limit=40, filter){
  const body={dateRanges:[{startDate:start,endDate:end}],metrics:[{name:'activeUsers'},{name:'sessions'},{name:'screenPageViews'},{name:'engagedSessions'}],dimensions:dims.map(n=>({name:n})),orderBys:[{dimension:{dimensionName:dims[0]}}],limit}
  if(filter) body.dimensionFilter=filter
  const r = await (await fetch(`https://analyticsdata.googleapis.com/v1beta/properties/${cfg.propertyId}:runReport`,{method:'POST',headers:{Authorization:`Bearer ${tok.access_token}`,'Content-Type':'application/json'},body:JSON.stringify(us?usOnly(body):body)})).json()
  console.log('\n## '+dims.join(','), us?'(US only)':'(ALL)', start,end)
  for(const row of r.rows||[]) console.log(row.dimensionValues.map(d=>d.value).join(' | '), '=>', row.metricValues.map(m=>m.value).join('/'))
}
await rep(['date'],'2026-10-08','2026-10-22',true)
await rep(['date','country'],'2026-10-08','2026-10-22',false,60,{filter:{fieldName:'country',inListFilter:{values:['Singapore','China','United States']}}})
const sg={filter:{fieldName:'country',stringFilter:{value:'Singapore'}}}
await rep(['browser','operatingSystem','deviceCategory'],'2026-10-14','2026-10-22',false,8,sg)
await rep(['sessionSource','sessionMedium'],'2026-10-14','2026-10-22',false,8,sg)
await rep(['hour'],'2026-10-18','2026-10-20',false,24,sg)
