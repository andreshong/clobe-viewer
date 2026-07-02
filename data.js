/* ============================================================
   Supabase 데이터 레이어 — clobe 실데이터(Postgres) 연동.
   SUPABASE_URL/ANON_KEY는 RLS로 보호되므로 공개해도 안전(공식 패턴).
   ============================================================ */
const SUPABASE_URL = "https://jogjhlqhxrkkjdktvvvs.supabase.co";
const SUPABASE_ANON_KEY = "sb_publishable_s4TQhSTjg07qbATTA21PNQ_rMdknXhf";
const supabaseClient = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

const BANK_NAMES = {
  "002":"산업","003":"기업","004":"국민","007":"수협","011":"농협","020":"우리",
  "023":"SC제일","027":"씨티","031":"대구","032":"부산","034":"광주","035":"제주",
  "037":"전북","039":"경남","045":"새마을","048":"신협","071":"우체국","081":"하나",
  "088":"신한","089":"케이뱅크","090":"카카오","092":"토스",
};
const bankNameOf = code => BANK_NAMES[code] || code;

const fmtDate = d => `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,"0")}-${String(d.getDate()).padStart(2,"0")}`;
// txn_at은 타임존 없는 UTC 태그로 저장된 한국 현지 시각 digits이므로,
// Date 객체로 변환하지 않고 문자열을 그대로 잘라 표시 (로컬 타임존 변환 방지).
const isoToDisplayDateTime = iso => iso ? `${iso.slice(0,10)} ${iso.slice(11,16)}` : "";

/* ---------- 인증 (이름+비밀번호) ----------
   인사평가 등 HR 앱과 동일한 이름·비밀번호로 로그인. clobe-hr-login Edge
   Function이 공유 HR 프로젝트의 hr_verify로 검증한 뒤 clobe 세션을 발급한다.
   (HR 데이터는 조회만, clobe는 자체 비밀번호를 저장하지 않음) */
async function getSession(){ const { data } = await supabaseClient.auth.getSession(); return data.session; }
async function signIn(name, password){
  let res;
  try {
    res = await fetch(`${SUPABASE_URL}/functions/v1/clobe-hr-login`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "apikey": SUPABASE_ANON_KEY },
      body: JSON.stringify({ name: name.trim(), password }),
    });
  } catch (e) {
    return { error: { message: "네트워크 오류" } };
  }
  const body = await res.json().catch(()=>({}));
  if (!res.ok || !body.access_token) {
    return { error: { message: body.error === "hr_unreachable" ? "인증 서버에 연결할 수 없습니다." : "이름 또는 비밀번호를 확인하세요." } };
  }
  const { error } = await supabaseClient.auth.setSession({
    access_token: body.access_token, refresh_token: body.refresh_token,
  });
  return { error };
}
async function signOut(){ return await supabaseClient.auth.signOut(); }

/* ---------- 설정 캐시 (카드사용자/계좌별명/거래처속성) ----------
   기존 localStorage 3종을 Supabase 테이블로 이관. 앱 시작 시 1회 전체
   로드해 메모리 캐시로 사용 — holderOf()/aliasOf()/attrOf()는 기존과
   동일하게 동기 함수로 유지. */
let cardHolders = {}, acctAlias = {}, partyAttrs = {}, accountNativeAlias = {};
async function loadConfigCache(){
  const [{data:h,error:eh}, {data:a,error:ea}, {data:p,error:ep}, {data:bx,error:ebx}] = await Promise.all([
    supabaseClient.from("card_holders").select("*"),
    supabaseClient.from("account_aliases").select("*"),
    supabaseClient.from("party_attrs").select("*"),
    supabaseClient.from("bank_accounts").select("display_account_number, alias_name"),
  ]);
  if (eh) throw eh; if (ea) throw ea; if (ep) throw ep; if (ebx) throw ebx;
  cardHolders = Object.fromEntries((h||[]).map(r=>[r.card, r.holder]));
  acctAlias   = Object.fromEntries((a||[]).map(r=>[r.account_num, r.alias]));
  partyAttrs  = Object.fromEntries((p||[]).map(r=>[r.party_name, {type:r.type, process:r.process, cost:r.cost, regno:r.regno, ceo:r.ceo, addr:r.addr}]));
  // clobe가 자체 제공하는 계좌 별명(aliasName) — 사용자가 account_aliases에 직접
  // 입력하지 않은 계좌는 이 값으로 폴백 (기존 목업의 DATA.accounts[].alias 폴백과 동일)
  accountNativeAlias = Object.fromEntries((bx||[]).map(r=>[r.display_account_number, r.alias_name||""]));
}
async function saveHolder(card, holder){
  cardHolders[card] = holder;
  const { error } = await supabaseClient.from("card_holders").upsert({ card, holder });
  if (error) console.error("saveHolder", error);
}
async function saveAlias(num, alias){
  acctAlias[num] = alias;
  const { error } = await supabaseClient.from("account_aliases").upsert({ account_num: num, alias });
  if (error) console.error("saveAlias", error);
}
async function savePartyAttr(name, key, value){
  (partyAttrs[name] = partyAttrs[name] || {})[key] = value;
  const { error } = await supabaseClient.from("party_attrs").upsert({ party_name: name, [key]: value });
  if (error) console.error("savePartyAttr", error);
}

/* ---------- 동기화 신선도 ---------- */
async function loadSyncState(){
  const { data } = await supabaseClient.from("sync_state").select("last_synced_at").eq("id","default").maybeSingle();
  return data?.last_synced_at || null;
}

/* ---------- 조회 함수 (기존 DATA.* 배열과 동일한 shape로 반환) ---------- */

async function fetchAccounts(){
  const { data, error } = await supabaseClient.from("bank_accounts").select("*")
    .neq("account_type","LOAN").order("krw_balance",{ascending:false});
  if (error) throw error;
  return (data||[]).map(a=>({
    bank: bankNameOf(a.bank_code), num: a.display_account_number, name: a.account_name||"",
    alias: a.alias_name||"", type: a.account_type, cur: a.currency,
    krw: a.krw_balance, fx: a.currency!=="KRW" ? Number(a.balance) : undefined,
  }));
}

async function fetchLoans(){
  const { data, error } = await supabaseClient.from("bank_accounts").select("*")
    .eq("account_type","LOAN").order("krw_balance",{ascending:false});
  if (error) throw error;
  return (data||[]).map(a=>({ name: a.account_name||"", num: a.display_account_number, krw: a.krw_balance }));
}

async function fetchTransactions(range){
  const { data, error } = await supabaseClient.from("transactions").select("*")
    .gte("txn_at", `${range.start}T00:00:00.000Z`).lte("txn_at", `${range.end}T23:59:59.999Z`)
    .order("txn_at", { ascending:false }).limit(2000);
  if (error) throw error;
  return (data||[]).map(t=>({
    date: isoToDisplayDateTime(t.txn_at), name: t.counterparty||"", desc: t.description||"",
    out: t.out_amount||0, in: t.in_amount||0, cat: t.category||null,
    acc: `${t.bank_name||""} ${t.account_number||""}`.trim(),
  }));
}

async function fetchCardUsage(range){
  const { data, error } = await supabaseClient.from("card_usage_view").select("*")
    .gte("used_date", range.start).lte("used_date", range.end)
    .order("used_date", { ascending:false }).limit(2000);
  if (error) throw error;
  return (data||[]).map(c=>({ date: c.used_date, merchant: c.merchant||"", card: c.card_no, amount: c.payment_amount, cat: c.category||null }));
}

async function fetchCardBilling(range){
  const { data, error } = await supabaseClient.from("card_statement_view").select("*")
    .gte("payment_date", range.start).lte("payment_date", range.end)
    .order("payment_date", { ascending:false });
  if (error) throw error;
  return (data||[]).map(c=>({ payDate: c.payment_date, merchant: c.category||"미분류", card: c.card_no, amount: c.total_amount_krw, cat: c.category||null }));
}

async function fetchTaxInvoices(range){
  const { data, error } = await supabaseClient.from("tax_invoices").select("*")
    .gte("issue_date", range.start).lte("issue_date", range.end)
    .order("issue_date", { ascending:false }).limit(2000);
  if (error) throw error;
  return (data||[]).map(t=>({ date: t.issue_date, partner: t.partner_name, regNo: t.partner_reg_no, type: t.type, supply: t.supply_value, vat: t.tax_amount }));
}

// clobe의 get_monthly_revenue(카드/마켓플레이스/배달/PG 정산매출)는 이 회사(B2B
// 제조업, 세금계산서 기반 거래)에는 해당 데이터가 없어 항상 0건 — 대신 매출
// 세금계산서(SALES) 공급가액을 월별로 집계해 "매출" 지표로 사용.
// range로 스코프하되, 차트 가독성을 위해 range.end 기준 최대 12개월까지만 표시.
async function fetchMonthlyRevenue(range){
  const end = new Date(`${range.end}T00:00:00`);
  let start = new Date(`${range.start}T00:00:00`);
  const minStart = new Date(end.getFullYear(), end.getMonth()-11, 1);
  if (start < minStart) start = minStart;
  const startStr = fmtDate(new Date(start.getFullYear(), start.getMonth(), 1));
  const { data, error } = await supabaseClient.from("tax_invoices").select("issue_date, supply_value")
    .eq("type","SALES").gte("issue_date", startStr).lte("issue_date", range.end);
  if (error) throw error;
  const byMonth = {};
  for (const r of (data||[])) {
    const m = r.issue_date.slice(0,7);
    byMonth[m] = (byMonth[m]||0) + r.supply_value;
  }
  return Object.keys(byMonth).sort().map(month=>({ month, net: byMonth[month] }));
}

async function fetchDistinctCards(){
  const { data, error } = await supabaseClient.from("distinct_cards").select("card_no");
  if (error) throw error;
  return (data||[]).map(r=>r.card_no);
}
const uniqueCards = fetchDistinctCards;

async function fetchDistinctParties(){
  const { data, error } = await supabaseClient.from("distinct_parties").select("party_name");
  if (error) throw error;
  return (data||[]).map(r=>r.party_name);
}
const uniqueParties = fetchDistinctParties;

/* 엔티티 드릴다운 모달용 — 특정 거래처/계좌/카드의 전체 기간 내역 */
async function fetchTransactionsByParty(name){
  const { data, error } = await supabaseClient.from("transactions").select("*")
    .eq("counterparty", name).order("txn_at",{ascending:false}).limit(500);
  if (error) throw error;
  return (data||[]).map(t=>({ date: isoToDisplayDateTime(t.txn_at), name: t.counterparty||"", desc: t.description||"", out: t.out_amount||0, in: t.in_amount||0, cat: t.category||null, acc: `${t.bank_name||""} ${t.account_number||""}`.trim() }));
}
async function fetchTaxInvoicesByParty(name){
  const { data, error } = await supabaseClient.from("tax_invoices").select("*")
    .eq("partner_name", name).order("issue_date",{ascending:false}).limit(500);
  if (error) throw error;
  return (data||[]).map(t=>({ date: t.issue_date, partner: t.partner_name, regNo: t.partner_reg_no, type: t.type, supply: t.supply_value, vat: t.tax_amount }));
}
async function fetchTransactionsByAccountNum(num){
  const { data, error } = await supabaseClient.from("transactions").select("*")
    .eq("account_number", num).order("txn_at",{ascending:false}).limit(500);
  if (error) throw error;
  return (data||[]).map(t=>({ date: isoToDisplayDateTime(t.txn_at), name: t.counterparty||"", desc: t.description||"", out: t.out_amount||0, in: t.in_amount||0, cat: t.category||null, acc: `${t.bank_name||""} ${t.account_number||""}`.trim() }));
}
async function fetchCardUsageByCard(card){
  const { data, error } = await supabaseClient.from("card_usage_view").select("*")
    .eq("card_no", card).order("used_date",{ascending:false}).limit(500);
  if (error) throw error;
  return (data||[]).map(c=>({ date: c.used_date, merchant: c.merchant||"", card: c.card_no, amount: c.payment_amount, cat: c.category||null }));
}
async function fetchCardBillingByCard(card){
  const { data, error } = await supabaseClient.from("card_statement_view").select("*")
    .eq("card_no", card).order("payment_date",{ascending:false}).limit(500);
  if (error) throw error;
  return (data||[]).map(c=>({ payDate: c.payment_date, merchant: c.category||"미분류", card: c.card_no, amount: c.total_amount_krw, cat: c.category||null }));
}

/* ---------- 배지/카운트 (전체 로우를 안 받고 count만) ---------- */
async function countInRange(table, dateCol, range){
  const { count, error } = await supabaseClient.from(table).select("*", { count:"exact", head:true })
    .gte(dateCol, dateCol==="txn_at" ? `${range.start}T00:00:00.000Z` : range.start)
    .lte(dateCol, dateCol==="txn_at" ? `${range.end}T23:59:59.999Z` : range.end);
  if (error) { console.error("countInRange", table, error); return 0; }
  return count || 0;
}
