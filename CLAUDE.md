# Clobe 조회창 (재무 데이터 뷰어) — 프로젝트 노트

Claude Code CLI 세션에서 시작해 데스크탑으로 이관됨. 이후 실 데이터 연동 + 로그인 웹앱으로 전환 완료. 이 문서는 이어서 작업할 때의 컨텍스트.

## 무엇인가
한국 회계/금융 SaaS **clobe**의 재무 데이터를 조회하는 대시보드. **실데이터 연동 완료** — Supabase 백엔드가 clobe MCP에 직접 OAuth로 붙어 자동으로 계속 동기화하고, 프론트엔드는 그 Supabase DB만 조회한다. 목업 시절의 `DATA` 객체는 제거됨.

배포: **https://clobe-viewer.vercel.app** (Vercel, 정적 사이트)
회사: **주식회사 제이앤에이취프레스** (companyId `333jqP4oyergXMo0QPYEq`, 사업자번호 1348621277)

## 아키텍처

```
[clobe API] --OAuth(PKCE, offline_access)--> [Supabase Edge Functions] --MCP JSON-RPC--> upsert
                                                                              |
                                                                        [Postgres] <-- RLS(authenticated만)
                                                                              ^
                                                                    supabase-js(anon key)
                                                              [index.html + data.js on Vercel] <-- 로그인 게이트
```

- Supabase 프로젝트: `clobe-viewer` (ref `jogjhlqhxrkkjdktvvvs`, ap-northeast-2, 조직 "Andres Hong" 소속 — 같은 조직의 "JNH Proposal"과는 무관한 별도 프로젝트)
- 브라우저는 clobe를 절대 직접 호출하지 않음 (MCP는 브라우저용 프로토콜이 아님). Supabase가 유일한 데이터 소스이자 인증 게이트.
- 로그인: **비밀번호 없는 매직링크**(이메일 클릭) 방식. 공개 가입 없음 — 계정은 관리자가 Admin API로 미리 생성. 현재 등록 계정: `hongchansu@kakao.com`.
- 이메일 발송: Kakao Mail SMTP로 커스텀 연결됨 (Supabase 기본 이메일 서비스는 시간당 발송 제한이 매우 낮아 즉시 막힘 — 실사용에는 커스텀 SMTP 필수).

## 파일 구조
- `index.html` — 뷰/렌더링/라우팅/챗봇/로그인 폼. 단일 파일 유지(빌드 없음), 5개 뷰 함수(overview/account/cards/tax/manage)는 전부 async로 Supabase를 조회.
- `data.js` — Supabase 클라이언트 초기화, 인증 헬퍼(`getSession`/`sendMagicLink`/`signOut`), 설정 캐시(`loadConfigCache`), `fetchX()` 데이터 함수들. `<script src="...supabase-js...">` 다음, `index.html`의 메인 스크립트보다 먼저 로드됨.
- `supabase/migrations/*.sql` — DB 스키마(0001~0005). 0005는 **뷰 RLS 우회 보안 수정**(아래 참고) — 반드시 유지.
- `supabase/functions/` — Edge Functions:
  - `clobe-oauth-start` / `clobe-oauth-callback` — clobe OAuth 최초 연동(1회, 소유자가 직접 브라우저 방문)
  - `clobe-backfill-init` — 백필 청크 시딩 (5년치, 월단위)
  - `clobe-sync-worker` — 실제 동기화 워커. `pg_cron`이 **4시간마다** 자동 호출(백필 중엔 1분마다였음, 완료 후 전환).
  - `clobe-create-user` — 회사 로그인 계정 생성용(1회성, 이메일 고정 하드코딩이라 재호출해도 안전)
  - `clobe-test-*` (test-refresh/test-tools/test-auth-view) — 진단용 임시 함수. 삭제 API가 없어 남아있음, 낮은 위험(verify_jwt 걸려있거나 토큰 노출 안 함).
- `.claude/launch.json` — 로컬 정적 서버 미리보기용(`npx serve`).

## DB 스키마 요약 (Postgres, Supabase)
전부 RLS 활성화. 재무 테이블은 `authenticated`만 select 가능, 쓰기는 오직 service_role(Edge Function)만.

- `bank_accounts` — 계좌+대출 통합(`account_type`: CHECKING/LOAN/FX/FUND). `dedup_key` = clobe의 실제 `bankAccountId`(안정적 숫자 ID).
- `transactions` — 은행 입출금. `dedup_key` = 실제 `transactionId`. **주의**: 같은 페이지 안에 동일 ID가 중복으로 올 수 있어 upsert 전 반드시 dedupe(이미 처리됨, `syncHandlers.ts`의 `upsertBatch`).
- `card_billing_items` — 카드 이용+청구 통합(원본이 건별 데이터라 이 형태가 맞음). `card_statement_view`(카드×결제일×계정 그룹 = 청구 화면용), `card_usage_view`(건별, 이용일 정렬 = 이용내역 화면용) 두 뷰 제공.
- `tax_invoices` — `dedup_key` = clobe 자체 invoice id(문자열). `partner_name`/`partner_reg_no`는 PURCHASE/SALES에 따라 상대방을 자동 선택(우리가 매입자면 공급자가 상대방, 반대도 마찬가지).
- `cash_receipts`, `monthly_revenue` — 이 회사는 데이터가 거의/전혀 없음(현금영수증 2건, 매출캘린더 0건 — B2B 세금계산서 기반 거래라 정상). 스키마는 항목 shape 미검증 상태로 방어적으로 매핑됨.
- `account_balance_trend` — **회사 전체 일별** 잔액추이(계좌별 아님). clobe 도구 자체가 `inquiryWeeks`(오늘부터 몇 주 전까지)만 받고 날짜 범위 지정이 안 됨.
- `card_holders` / `account_aliases` / `party_attrs` — 기존 localStorage 3종 대체. `authenticated`면 읽기/쓰기 가능(회사 공용 설정).
- `sync_state` — 프론트 상단바 "마지막 동기화" 표시용 단일 행.
- `clobe_oauth_tokens` / `clobe_sync_state` / `backfill_chunks` / `oauth_pkce_state` — 내부 전용, `service_role`만 접근(RLS 활성화 + 정책 없음 = anon/authenticated 완전 차단).
- **뷰 5개**(`card_statement_view`/`card_usage_view`/`monthly_revenue_totals`/`distinct_cards`/`distinct_parties`)에는 `security_invoker = true`가 반드시 설정돼 있어야 함 — 없으면 뷰가 소유자 권한으로 실행되어 RLS를 우회하고 anon 키로 실데이터가 그대로 노출됨(실제로 한 번 발생했던 취약점, 0005 마이그레이션에서 수정). **새 뷰를 추가할 때마다 이 옵션을 반드시 넣을 것.**

## clobe MCP 실전 노트 (실제 tools/list + 응답으로 검증됨)
- 모든 도구 파라미터는 `{ input: {...} }`로 한 겹 감싸야 함 (`arguments: { companyId, ... }`가 아니라 `arguments: { input: { companyId, ... } }`) — 안 그러면 전부 동일한 `INTERNAL` 에러로 실패해서 원인 파악이 어려움.
- 날짜는 `[year, month, day]` / `[y,m,d,h,mi,s]` 배열로 옴 (Java LocalDate 직렬화), ISO 문자열 아님. 변환 시 **로컬 타임존을 거치는 `new Date(y,m-1,d,...)`는 쓰면 안 됨** — 실행 환경의 타임존에 따라 시각이 밀림. 문자열을 직접 조립해서 "Z" 태그만 붙일 것(`_shared/clobeDates.ts` 참고, 한 번 버그였다가 수정됨).
- `get_labeled_transactions`: cursor 페이징(`nextCursor`/`hasNext`), 안 주면 최근 90일 기본.
- `get_labeled_card_billing_items`: page/size 페이징, **결제일(payDate) 기준** 필터 — 하루 단위로 조회하면 십중팔구 0건.
- `get_tax_invoices`/`get_cash_receipts`/`get_monthly_revenue`: startDate/endDate **필수**(생략 불가), page/size 페이징.
- `get_account_balance_trend`: `inquiryWeeks`만 받음, 날짜 범위 지정 불가.
- `get_bank_accounts`/`get_scraping_status`/`get_my_context`: companyId만.
- MCP 서버가 SSE(`text/event-stream`)로 응답할 수도 있어 Content-Type 분기 처리 필요(`_shared/mcpClient.ts`).
- OAuth는 표준 OAuth 2.1 + 동적 클라이언트 등록(`/oauth/register`) + PKCE(공개 클라이언트, secret 없음) + `offline_access` 스코프로 refresh_token 발급. Claude와 무관하게 백엔드가 자체 등록해서 씀 (`CLOBE_CLIENT_ID`는 `_shared/clobeConfig.ts`에 하드코딩 — 민감정보 아님, 공개 client_id일 뿐).
- clobe 자체 데이터 최신화(재수집)는 이 앱/MCP로 트리거 불가 — 사용자가 app.clobe.ai에서 직접.

## 구현된 기능
- 개요(KPI·월매출 차트·상위계좌·어제 입출금) — 월매출은 clobe의 `get_monthly_revenue`(카드/마켓플레이스 정산)가 이 회사엔 0건이라, **매출 세금계산서(SALES) 공급가액 월별 합계**로 대체 계산.
- 계좌·입출금(병합): 상단 8지표, 계좌별 탭, 검색, 거래처/계좌 클릭 시 모달, 계좌별 잔액표(종료일 기준 롤백 추정 — 종료일 이후 거래를 별도 조회해서 역산)
- 카드 내역: 이용내역/청구내역 탭, 사용자(카드)별 필터, 카드 클릭 모달
- 세금계산서·매출: 매출/매입 필터, 순액
- 환경설정(`manage`): 계좌 별명 매칭 / 카드 사용자 매칭 / 거래처 등록 — 전부 Supabase에 저장(기기 간 공유)
- 엔티티 드릴다운 모달(거래처·계좌·카드) — 전체 기간 조회지만 최근 500건 캡
- 챗봇 — 날짜 표현(어제/이번 달/작년 등)이 실제 `TODAY = new Date()` 기준으로 동적 계산됨(예전 목업은 2026-07-02 하드코딩이었음)
- 조회 결과 2,000건 캡 + 안내 문구(대량 조회 시 기간을 좁히라는 경고)

## 백필/동기화 상태
- 5년치 백필 완료 (거래 3,925건, 카드 11,473건, 세금계산서 5,007건, 계좌 38개, 잔액추이 364일).
- `pg_cron` job `clobe-sync-worker-tick`이 **4시간마다** 자동 호출 (`cron.job` 테이블에서 확인 가능). 백필 중엔 1분마다였다가 완료 후 전환함 — 스키마를 바꾸거나 대량 재백필이 필요하면 `clobe-backfill-init` 재호출 + `cron.alter_job`으로 다시 1분 주기로 낮췄다가 완료 후 4시간으로 복귀.
- 동기화 실패 시 `clobe_sync_state.last_error` / 프론트 상단바 "동기화 끊김" 배너로 확인 가능(설계상 그렇게 되어 있음 — 실제 배너 UI는 아직 미구현, 향후 개선 후보).

## 알려진 이슈 / 향후 개선 후보
1. 진단용 임시 Edge Function들(`clobe-test-*`) 삭제 — Supabase MCP에 delete 도구가 없어 대시보드에서 수동 삭제 필요.
2. 동기화 실패 알림 배너를 프론트에 실제로 붙이기(현재는 DB에 에러가 쌓이기만 함).
3. 현금영수증(cash_receipts)/잔액추이(account_balance_trend) 화면 추가 — DB엔 이미 있음.
4. `get_cash_receipts`/`get_monthly_revenue`의 실제 항목 shape가 이 회사 데이터로는 검증 안 됨(데이터가 없어서) — 다른 회사 연동 시 재검증 필요.
5. Vercel 자동 배포(git push 연동)는 설정 안 됨 — 현재는 `npx vercel --prod --token=...` 수동 배포. 이 PC의 Vercel CLI(로그인 계정명에 한글 포함)는 `vercel login`/`whoami` 시도 시 헤더 인코딩 버그로 깨짐 — `--token` 옵션으로 우회.

## 실행
- 프론트 로컬 미리보기: `npx serve -l 5173 .` (또는 `.claude/launch.json`의 preview_start)
- 배포: `npx vercel@latest --prod --token=<vercel.com/account/tokens에서 발급>` (프로젝트 루트에서)
- Supabase 프로젝트 콘솔: https://supabase.com/dashboard/project/jogjhlqhxrkkjdktvvvs
