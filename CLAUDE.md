# Clobe 조회창 (재무 데이터 뷰어) — 프로젝트 노트

Claude Code CLI 세션에서 시작해 데스크탑으로 이관됨. 이 문서는 이어서 작업할 때의 컨텍스트.

## 무엇인가
`index.html` **단일 파일** 웹앱(빌드·인터넷 불필요, 더블클릭 실행). 순수 HTML + CSS + vanilla JS.
한국 회계/금융 SaaS **clobe**의 재무 데이터를 조회하는 대시보드. 현재는 **목업(정적 DATA) 방식** — 실제 API를 실시간 호출하지 않고, clobe에서 조회한 값 일부를 코드에 시드로 넣어둔 상태.

회사: **주식회사 제이앤에이취프레스** (companyId `333jqP4oyergXMo0QPYEq`, 사업자번호 1348621277)

## 파일 구조
- `index.html` 하나가 전부. 상단 `<style>`, 하단 `<script>`.
  - `DATA` 객체: accounts / loans / transactions / cardBilling / cardUsage / taxInvoices / monthlyRevenue. **실연동 시 이 객체만 clobe 응답으로 교체하면 화면 로직 그대로 동작하도록 설계.**
  - 영속 저장(localStorage): `clobe_card_holders`(카드 사용자), `clobe_account_alias`(계좌 별명), `clobe_party_attrs`(거래처 속성).
  - 뷰: `overview` / `account`(계좌·입출금 병합) / `cards` / `tax` / `manage`(환경설정). `VIEWS` 맵 + `go()` 라우팅.
  - 전역 기간(`dateRange`) 상단바에서 제어(프리셋 + 직접지정). `TODAY = 2026-07-02`(데이터 기준일)로 앵커.
  - 챗봇: 우하단 💬. 규칙 기반 자연어 파서(`parseChat`) → `chatAnswer` → 미니표 + "화면에서 보기" 액션.

## 구현된 기능
- 개요(KPI·월매출 차트·상위계좌·어제 입출금)
- 계좌·입출금(병합): 상단 8지표(예금/펀드/외화/대출/이월/입금/출금/기말), 계좌별 탭, 거래유형·공정·비용유형 **컬럼**, 검색, 거래처/계좌 클릭 시 모달, 계좌별 잔액표(종료일 기준 롤백 추정)
- 카드 내역: 이용내역/청구내역 탭, 사용자(카드)별 필터, 카드 클릭 모달
- 세금계산서·매출: 매출/매입 필터, 순액
- 환경설정(`manage`): 계좌 별명 매칭 / 카드 사용자 매칭 / **거래처 등록(테이블 + 헤더정렬 + 검색)**
- 엔티티 드릴다운 모달(거래처·계좌·카드), 다크모드 자동, sticky 헤더
- 기간 조회는 전체 데이터 표시(페이지 제약 없음)

## 실데이터 반영 현황 (발췌 시드)
- 세금계산서: 2026-06-25~07-01 실제 30건
- 카드: 실제 카드 11장 + 이용 25건(6/25 청구분) + 사용자명 자동 매칭(조*성/조*현/조*철/조*민/법인)
- 계좌/거래: 실제 조회값 기반 발췌
전체는 아직 앱에 없음(세금계산서 연 1,833건, 카드 4,850건 규모).

## clobe MCP (데이터 소스)
CLI에서 추가됨: `claude mcp add --transport http clobe https://api.clobe.ai/mcp` (OAuth 인증 필요).
데스크탑에서도 동일 MCP 추가 + 인증 필요.

사용 가능한 조회 도구와 한계:
- `get_my_context` — companyId 확보 (항상 먼저)
- `get_bank_accounts` — 계좌·잔액(스크래핑 시점 스냅샷)
- `get_labeled_transactions` — 은행 입출금 (기간/방향/계좌/카테고리 필터, 커서 페이징)
- `get_labeled_card_billing_items` — **카드 결제(청구)내역**. 건별로 카드번호(마스킹)·userNames·가맹점·사용일·결제일·카테고리 포함 → 사실상 카드 이용내역까지 확보. **주의: 결제일 기준**이라 특정 하루로 조회하면 0건 나오기 쉬움(청구일이 보통 25일).
- `get_tax_invoices` — 세금계산서(매출/매입)
- `get_cash_receipts` — 현금영수증
- `get_monthly_revenue` — 매출 캘린더(카드/마켓플레이스/배달/PG)
- `get_account_balance_trend` — 잔액 추이(주 단위)
- `get_labels` / `bulk_label_transactions` / `label_card_billing_items` — 라벨링
- `get_scraping_status` — 수집 상태/최신성
- 리소스: `clobe://companies`
- **없는 것**: 카드 승인내역 전용 도구, 카드 목록 전용 도구(청구내역에서 카드 추출로 대체). 데이터 최신화(재수집)는 MCP로 트리거 불가 — app.clobe.ai에서 사용자가 직접.
- 모든 금액 KRW. 데이터는 실시간 아님(마지막 스크래핑 시점).

## 다음 단계 후보
1. **실제 API 연동**: 앱 실행 시 clobe(OAuth) 호출해 `DATA`를 실데이터로 채우기. 기간·페이지 단위 조회 필수(볼륨 큼). CORS/인증 처리 필요 → 별도 백엔드/프록시 또는 Claude Code에서 MCP로 받아 시드 갱신.
2. 정식 React/Vite 프로젝트로 분리(빌드형)
3. CSV/엑셀 내보내기
4. 거래처 등록에 입력한 속성으로 헤더 필터(현재는 컬럼 표시 + 검색만)
5. 카드 나머지 BC 카드 사용자명 매칭 채우기

## 실행
`index.html` 더블클릭 또는 브라우저로 열기. 저장 데이터는 브라우저 localStorage.
