# Legacy partner module ("12.") + seller commission (17.) — functional spec

Source: `/home/claude/src` files 047–066, 087, 089 (read-only analysis, 2026-11-02).
Script time zone (`000_appsscript.json`): `Asia/Singapore` (UTC+8, same offset as Lombok).
All `new Date()` formatting below is in that zone.

## 0. Entry points, roles, shared helpers

- **No menu.** There is no `createMenu`/`addItem` anywhere in `src`. The two `onOpen()` (073, 074; the
  later definition wins) only re-lock sheets if script property `sheetsUnlocked` == `"true"`.
  Top-level functions nobody calls in code, so they are bound to drawing/image buttons in the sheet:
  `showActivityWindow()` (047), `showBillList()` (060), `copyRowsToTemp()` (087),
  `fillMissingSellerValues()` (089). `fillMissingSellerValuesWithoutLock()` is also called by
  `runSequentialTasks()` in `021_7.saveCopy.gs` (monthly "save copy").
- **Roles:** the code has no role check. Inferred: receptionists can run every flow (they are not
  editors, which is why every write goes through `manageSheetProtection('unlock'|'lock')`, a
  service-account unlock/re-lock of all sheets listed in the "Protect" tab). The manager watches the
  results: cost edits are emailed to `rabbittree.system.alerts.com@gmail.com`, bills go to
  `therabbittreegilimeno@gmail.com`. Settling a bill (creating the cash/transfer payment row) and
  fixing sellers are manager-style actions, but nothing enforces that.
- **Lock pattern:** `manageSheetProtection('unlock')`, then set the script property `sheetsUnlocked`=`"true"`, then the writes; in
  `finally`: `manageSheetProtection('lock')` and delete the property. `getServiceToken2()` is also
  called first, but its result is unused.
- **Temp sheets** (overwritten by many other modules too, so not safe for concurrent use):
  `"Temp"` = a copy of the filtered Entries rows (same 20/21 columns, header row 1);
  `"Temp2"` = 9-column dialog payload *or* 4-column payment summary; `"Temp3"` = settlement payload.
  `"temp"` / `"temp2"` lower-case spellings also appear (Apps Script `getSheetByName` is
  case-insensitive in practice).
- **`formatDate` is defined 5 times** (058, 065, 079, 081, 087). The global one that is actually used is
  the definition that loads last, which is `087`: `formatDate(date)` → `dd/MM/yyyy`. It calls `date.getDate()`, so it
  **throws on strings**. All variants output `dd/MM/yyyy`.
- `enforceDateFormat(v)` (052) → `new Date(v)` → `yyyy-MM-dd`. The value it receives is the
  dialog text `dd/MM/yyyy`, which JS parses as **MM/dd/yyyy**, so day and month are swapped when day ≤ 12,
  and the original string is kept when day > 12. This only affects Temp2/Temp3 and the PDFs, never Entries.
- `cleanData(v)` (058): `""`/null → `"0"` (string), else `parseFloat` or `"0"`.

## 1. How a "partner" line is identified

- Partner products = strings starting with `"-"` in the `"Data activities"` sheet:
  `L1:L15` (scanned from L1; the header is pushed too if it starts with "-"), `M2:M50`, `N2:N50`.
  The headers L1/M1/N1 are the group titles (partner categories, e.g. tours / transports).
- An Entries row belongs to partner X when `D` (object) **equals exactly** (`includes` on the
  trimmed D) one of the selected strings. Type B is not filtered: Income and Expense rows are both taken.
- 087/089 use a broader rule: `D.startsWith('-')`.
- The partner "category" for a payment row = the row-1 header of the column in `"Data activities"!K1:O40`
  where the object string is found (`findCategoryHeader`, exact match, rows 2..40).
- Payment types: `"Data activities"!Q2:Q20` (the payment flow excludes `"Paid to Partner"`).

## 2. Entries column S = partner billing status (the "bill" concept)

| S value | Meaning | Written by |
|---|---|---|
| `""` | pending, not billed | initial; `deleteBill` clears back to "" |
| `B_dd/MM-HH:mm` e.g. `B_03/02-14:07` | line belongs to that bill (the bill **is** this string) | `formatUpdateTime()` in 059 at bill creation |
| `"Paid"` | billed and settled | `updateEntriesColumnS` (063) |
| `"Settled"` | the payment row itself | `finalizePayment` (064) |

- A **bill has no storage of its own**: its ID is the S marker shared by its lines. The bill PDF is emailed
  and then trashed from Drive. The bill list is rebuilt from `Entries!S:S`.
- The ID has minute resolution and **no year**: two bills made in the same minute, or on the same
  date/time in different years, merge into one bill.
- The views filter on: Pending = `S.trim()===""`; Settled = `S.toLowerCase().trim()==="paid"`;
  Billed = `S.startsWith("B_")`.

## 3. Sidebar "Activity Selection" — `showActivityWindow` (047, 048)

- A 300 px sidebar. It lists checkboxes grouped under headers L1/M1/N1 (see §1). Three buttons send the
  checked labels (nothing happens if none are checked):
  - `Pending` → `handleUnpaidSelection` (§4)
  - `Settled` → `handlePaidSelection` (§5)
  - `Billed but Pending` → `handleAllSelection` (§6)

## 4. Pending view + Write Modifications + Create Bill

### 4.1 Load — `processActivitySelection(items,"unpaid")` (049) then `showPartnerData()` (050)
- Reads `Entries` getDataRange. It keeps rows where D is a string, `S.trim()===""`, and `items.includes(D.trim())`.
- `Temp.clear()`, then writes the Entries header row and the matching rows (full width). If nothing matches, Temp stays
  empty and the dialog shows the alert `No data found in Temp.`
- No lock is taken. If S holds a non-string (number or Date), `.trim()` throws, Temp is **not** rewritten, and
  the dialog shows **stale Temp data** (`showPartnerData` is still called).
- `gatherPartnerData()` (051) reads Temp by **header names** (it throws an alert listing the missing ones):
  `"Date"`, `"object"`, `"Qty"`, `"Auto price"`, `"Real price (if different)"`,
  `"Real cost (if different)"`, `"Theorical cost"`, `"Guest"`, `"Time stamp"`, `"Comment"`,
  `"Payment Type"` (the Entries row-1 headers; the code does not show which letter each one maps to.
  Presumably G/H/L/K-or-J/M/O/Q/N).
  - It skips rows where Guest (case-insensitively) = `payment to partner`.
  - qty = Qty or 1; price = realPrice || autoPrice; cost = realCost>0 ? realCost : theoreticalCost.
  - commission = price − cost **only if** Payment Type === `"Payment to Partner"`, else 0.
- Dialog `"Pending Partner Data (Unpaid)"` (1100×600). For each object it shows:
  - "**(Standard Transactions)**" for items with commission === 0: Select, Date (`formatDate`), Qty,
    an editable Cost input, Guest, Comment, and a hidden timestamp.
  - "**(Paid to Partner Transactions)**" for items with commission ≠ 0: Select, Date, Qty, Commission
    (= cost − price, the opposite sign of the server-side value), editable Price and Cost, Guest, Comment, hidden timestamp.
  - Subtotals only add the checked rows: the standard subtotal is the sum of cost and the paid subtotal is the sum of (cost − price).
    **Qty is ignored** in all totals (the server-side `totalCost=cost*qty` is computed but never shown).
  - Buttons: `Select All`, `Unselect All`, `Write Modifications`, `Reload Initial Data`, and
    `Create Bill` (the last one is hidden in the Settled view).
- **Bug (effective behavior):** in Entries N the guest-paid-partner value is `"Paid to Partner"`, but the
  code tests `"Payment to Partner"` (that string is the *guest* marker of payment rows). So commission is
  always 0 and every line shows as a Standard Transaction. Lines where the guest paid the partner directly
  are billed as if Rabbit Tree owed the full cost. The filter `item.paymentType !== "Paid to Partner"` is
  dead code because paymentType is not copied into the items.

### 4.2 Write Modifications — `processModifiedData(rows)` (052) → `updateEntriesFromTemp2()` (053)
1. A blocking alert: `Only the lines with boxes ticked will be modified.`
2. `Temp2` (created if missing): rows 2..last are cleared, then one row per checked line is written in columns A..I:
   `[object, enforceDateFormat(date), qty, cleanData(cost)||"", cleanData(price)||"", cleanData(commission)||"", guest, comment, timestamp]`.
   A cost of 0 becomes `""` and is therefore not written.
3. Unlock. Each Temp2 row is matched to the **first** Entries row where `D==object && M==guest && O==timestamp`
   (loose `==`; the timestamp comes back from the HTML as text).
4. For each match with a non-empty cost: **`Entries!L` (col 12) = Temp2 D**. Nothing else is written. All
   checked rows are written even when unchanged, so the theoretical cost gets copied into L.
5. If there were matches: `sendUpdateNotificationEmail` (054), an alert
   `N rows have been modified.\n\nTo cancel these modifications: \nClick on "Reload Initial", click the same tickboxes then "Write Modifications".`,
   then `syncEntriesToManual2()` (046, a full Entries→Entries Manual resync). Otherwise the alert is `No modifications were made.`
6. Lock, in `finally`.
- Email (054) to `rabbittree.system.alerts.com@gmail.com`. The subject is `Modification data Partner in entries`,
  or `Attention! Modification data already Paid Partner in entries` if any Temp S contains `"Paid"`.
  The HTML body lists each change (Row, Object, Guest, New Cost, Modified by = Entries I, which is the original author, not the
  editor) and the Temp "initial data" (D, E, M, L, O). `Qty` and `New Price` print **`undefined`**.
- The Price edits are collected but **never written**: Entries H is not updated.

### 4.3 Create Bill — `createBillWithModifications()` (client)
1. Runs `writeModifications()` (all of §4.2, including the alert email).
2. After a fixed `setTimeout(1500)`, `createBill()` → `senddatatoTemp2(rows)` (058). **Race:** both
   calls clear and write `Temp2`, and §4.2 can still be paused on its blocking alert at that point.
3. `senddatatoTemp2`: Temp2 rows 2.. are cleared. Same 9 columns, but cost/price default to `"0"` instead of "".
   Then:
   - `generateBillFromTemp2()` groups by object into the sections `"Paid at the rabbit tree"` (price or
     commission falsy) and `"Paid by the guest to the Partner"`. It builds HTML: title `Bill (<objects joined ", ">)`,
     `Created by <email>`, the timestamp, per-row Date/Qty/Cost/Price Sold/Commission/Guest Name,
     `Total Cost`, `Total Commission`, `Total of Category`, `Total Invoiced`, and
     `Best Regards from The Rabbit Tree Team!`. Qty is ignored.
     The PDF is named `Bill_<ISO with : and . replaced by ->.pdf`. It is emailed **to the active user and
     `therabbittreegilimeno@gmail.com`** with the subject `Bill (<objects>) - Created by <email> on <locale datetime>`
     and the body `Please find the attached bill.` The Drive copy is then trashed. An alert follows:
     `Open the Gmail of the account used now or therabbittreegilimeno@gmail.com to find the PDF and share it with the partner for confirmation.\n\nDon't forget to come back on the Bill when it has been paid!`
   - `updateBillEntriesFromTemp2("Bill")` (059; the argument is unused): unlock, then match each Temp2 row to the first
     Entries row with `D==object && E==qty && M==guest && O==timestamp`. For each match it writes
     **`L` = Temp2 cost** (if not "") and **`S` = `B_dd/MM-HH:mm`**. `formatUpdateTime(new Date())` is computed per row,
     so a bill created across a minute boundary gets **two IDs**. It shows the same "N rows have been modified…" alert,
     runs `syncEntriesToManual2()`, then locks.
- **Order of writes for one Create Bill:** Temp2 → Entries L (+ alert email + sync) → Temp2 → PDF email →
  Entries L, S → sync.
- **Idempotency:** none. Pressing the button twice inside the same minute is harmless (same S). Lines that are already billed
  are not in the Pending view, so they cannot be billed again.

## 5. Settled view — `handlePaidSelection` (055)
- `processPaidSelection` unlocks and locks around a read-only operation (unnecessary). It writes Temp = header + rows with
  `S.toLowerCase().trim()==="paid"` and D in the selection. Then `showPartnerData(true,"Settled Partner Data (Paid)")`
  opens the same dialog as §4.1 without `Create Bill`. **Write Modifications stays active**, so the cost of
  already-paid lines can be changed (this triggers the "Attention!" email).

## 6. Billed-but-pending view — `handleAllSelection` (056)
- `processAllSelection`: Temp = header + rows with `String S` starting `"B_"` and D in the selection (no lock).
- `showPartnerData2()` (057) + `gatherPartnerData2()`: skips Guest `payment to partner`, skips S `"Settled"`,
  and keeps only rows where S starts with `B_`. cost = realCost || theoreticalCost.
- Read-only modal `(Read Only) Billed but still pending`: per object it shows Date, Qty, Cost, Guest, Comment, with a `Reload` button.

## 7. Bill List — `showBillList` (060, 061)
- `getSortedUniqueValues()`: unique values in `Entries!S:S` that start with `"B_"`. The sort is broken because it
  splits `"B_03/02-14:07"` on `/`, which gives hour/minute NaN and year hard-coded `2023`, so the dates are Invalid and the order
  is effectively undefined. Paid bills (S=`"Paid"`) disappear from the list.
- Modal `Bill List` (800×600) shows one button per bill ID. A click runs `openFilteredSummary(id)`, which writes Temp (created if
  missing, else cleared) = header + rows with `S == id`. If there are none, it alerts `No matching entries found for: <id>`.
  Otherwise it calls `showBillData()`.

## 8. Bill dialog — `showBillData(false,"Unpaid Bill")` (062)
- Uses the same `gatherPartnerData()` and the same two-section table as §4.1. The checkboxes are hidden and are all
  ticked on load, and the cost inputs are borderless but **still editable** (the edits change the total and the
  payment, but are never written to the lines).
- Buttons: `Back To Bills` (calls `showBillList`), `This Bill is Paid!`, `Delete`.
- The client `writeModifications()` here contains a corrupted selector
  (`trDied to preserve the original order, here is the continuation:` …). It is not wired to any button. The client-side
  `writeCategoryTotalsToTemp2` uses `SpreadsheetApp` in the browser, which is dead code.

### 8.1 Delete — `deleteBill()` (066)
- `confirm("Are you sure you want to delete this bill?")`, then unlock. `billId = Temp!S2`. Every Entries row with
  `S == billId` gets **S cleared**, then Temp!S2 is cleared and the sheet is locked again. Nothing else happens: the L costs written at bill time stay,
  and no email is sent. The lines return to Pending. If Temp!S2 is empty it matches the empty S cells (a no-op).

### 8.2 "This Bill is Paid!" — settle flow
1. Client: select all, then read `grandTotal` (the sum of all subtotals; the paid-to-partner subtotals are cost − price,
   so a net negative means the partner owes Rabbit Tree). `getAvailableOptions()` returns
   `"Data activities"!Q2:Q20` non-empty values except `"Paid to Partner"`, shown as buttons under "Select a Payment Type",
   followed by a confirmation modal "Confirm Payment Type: X / Total Amount: T" with `Cancel` and `Confirm`.
   `categoryTotals` = `{"<object> (Standard Transactions)": subtotal, "<object> (Paid to Partner Transactions)": subtotal}`.
2. On Confirm, two server calls start **in parallel** (no ordering):
   - **A. `createBill()` → `senddatatoTemp22(rows)` (065):** Temp3 rows 2.. are cleared and the same 9 columns are written,
     then `generateBillFromTemp3()` builds the same HTML. The PDF is `Billsettled<ISO>.pdf` and it is emailed to the
     **active user, `therabbittreegilimeno@gmail.com`, `rabbittree.system.alerts.com@gmail.com`** with the subject
     `BillSettlement (<objects>) - Created by <email> on <datetime>`. The Drive copy is trashed. Alert:
     `Open the Gmail of the account used now or therabbittreegilimeno@gmail.com to find the PDF if needed. The Bill is now registered as paid!`
     It writes nothing to Entries, then closes the dialog.
   - **B. `processPayment(paymentType, totalValue, categoryTotals)` (063):**
     a. `writeCategoryTotalsToTemp2`: Temp2 is cleared and written as
        `["Category","Total Amount","Payment Type","Timestamp"]` + one row per key:
        `[key, total.toFixed(2), paymentType, Utilities.formatDate(now, tz,'yyyyMMddHHmmssSSS')]`.
        The timestamp is generated in a loop, so the rows usually share **the same ms**.
     b. A bogus loop: if `Entries` col A equals a category key, set **col E (Qty)** to `"paid"`. This never
        matches, but it would corrupt Qty if it did.
     c. `finalizePayment(paymentType, totalValue)` (064; totalValue is unused): unlock.
        - Dedupe: if any Temp2 `D2:D` timestamp is already in `Entries!O` it exits silently. The timestamps were just
          generated, so this protects nothing in practice.
        - paymentMethod = `Temp2!C2`. The key suffixes ` (Standard Transactions)` / ` (Paid to Partner Transactions)` are stripped,
          so **both keys of one partner collapse and the last one overwrites the first** (one amount is lost
          if a partner had both sections). Rows with amount 0 are kept, which gives a 0-value payment row.
        - **Payment row written to `Entries`** at `getLastRow()+1`, 19 values A..S:

          | Col | Value |
          |---|---|
          | A | `Utilities.formatDate(now,tz,'dd/MM/yyyy')` (a string; the sheet locale parses it) |
          | B | `"Expense"` if sum ≥ 0, `"Income"` if sum < 0 |
          | C | category header from Data activities K1:O40 (e.g. `Transport`), else "" |
          | D | partner object, e.g. `-Wijaya bali(no pick,mn boat)` |
          | E,F,G | "" |
          | H | `abs(sum)` if Income, else "" |
          | I | active user email |
          | J,K | "" (J/K show values later only if Entries has formulas there; the observed J 375000 is not written by this code) |
          | L | `sum` if Expense, else "" |
          | M | `"Payment to Partner"` (sum ≥ 0) or `"Payment From Partner"` (sum < 0) |
          | N | the chosen payment type (e.g. `Transfer/Others`) |
          | O | the Temp2 timestamp `yyyyMMddHHmmssSSS` (read back from the sheet as a number, so 17 digits risk precision loss) |
          | P,Q,R | "" |
          | S | `"Settled"` |
        - **Mirror row in `Entries Manual`** at `getTrueLastRow()+1`: the Entries row is read back over **21 columns
          (A..U)** and copied, then: I = `"To agent"` (Payment to Partner) / `"From agent"` (+H=abs);
          **O = user (from I)**, **Q = timestamp (from O)**, S = "". Every other cell is copied **as a value**, including
          F,G,J,K, which **overwrites the formula columns of Entries Manual** and leaves I in Manual holding
          "To agent"/"From agent". `syncEntriesToManual2` is not called.
        - `"New guest"` col F: if `"Payment to Partner"` / `"Payment From Partner"` are missing, they are appended at
          `F2.getNextDataCell(DOWN).offset(1,0)`.
        - Temp2 `clearContents()`, then lock in `finally`. Errors are only logged (the caller still continues).
     d. `updateEntriesColumnS()`: `lookup` = first non-empty `temp!S2:S` (the bill ID). The whole `Entries!S:S` is read,
        every cell equal to the ID is replaced by **`"Paid"`**, and the **entire column is written back**. It does **not unlock**
        (the sheet was already re-locked by c), but it locks again in `finally`. For a non-editor this write fails, the payment row is
        already in Entries, the lines stay `B_…`, and the bill stays in the list. Pressing Paid again creates **duplicate
        payment rows** with no dedupe.
- Matches the observed row: Expense / Transport / `-Wijaya bali(no pick,mn boat)` / L 2250000 / guest
  `Payment to Partner` / N `Transfer/Others`.

## 9. Seller commission — 087 `copyRowsToTemp()` ("Sales with commission")
- Purpose: assign the **seller** (the staff member credited with a tour/transport sale, for staff commission). It does not
  compute any amount.
- Filter (`Entries`, all rows including the header): `D.startsWith('-')`, `Q !== 'Refunded'`, `Q !== 'Refunding'`,
  `S !== 'Settled'`, `P !== 'Past'`, `D !== '-Sunset Boat'`, `D !== '-Bike Suma'`. Type is not filtered.
  `Temp.clear()`, then the matching rows are written from row 1 (no header).
- Modal `Sales with commission` (800×600) has these columns: Date (`dd/MM/yyyy`), Object, Guest Name (M), Price
  (H, or G if H is `null`/`0`; **an empty H, which is `""`, is shown as blank**), Author (I), Seller dropdown, hidden timestamp (O).
  The seller is T, falling back to I. The options come from `"Protect"!B2:B10` (staff emails).
  If the current seller is not in the options, the browser preselects the first option.
- Each dropdown change runs `updateSellerInTempSheet`: `Temp!T(row i+1)` = seller, plus an email to **every non-empty
  Protect!B2:B10** with subject `Seller Modified` and a plain body listing the original and modified Temp row.
- `Modify` closes the dialog, then `updateBothSheetsWithSellers(all rows, changed or not)`: unlock;
  `Entries!T` (col 20) = seller for the row whose `O.toString()` matches the timestamp; `Entries Manual!R` (col 18) =
  seller for the row whose `Q.toString()` matches; one `Seller Modified` email **per row per sheet per recipient**
  (an email flood, also for unchanged rows); then lock. `Download as PDF` uses client-side jsPDF + html2canvas
  (`sales_data.pdf`).

## 10. 089 `fillMissingSellerValues()` — what it fixes
- It backfills the seller where it is missing (a default seller = the author). It unlocks first, and the `…WithoutLock` variant is run at month save.
  - `Entries`, rows 2..: if `D` starts `-`, `D !== "-Sunset Boat"`, `Q` not `Refunded`/`Refunding`, `T === ""`,
    and `I !== ""`, then **T = I** (author). The whole column T from row 2 is rewritten (the existing values are re-written).
  - `Entries Manual`, rows 2..: same rule, with the comment test on **P**, the source **O** (author) and the target **R**.
- Unlike 087 it does not exclude `-Bike Suma`, `Settled` or `Past` rows.

## 11. Bugs / inconsistencies to avoid copying
1. **Refund markers:** 085 writes `'Refund-ed'` / `'Refund-ing'` (Entries Q; Entries Manual **R**). 087/089
   test `'Refunded'`/`'Refunding'`, so refunded sales are never excluded. In Entries Manual, 089 tests P while the marker is in R,
   and **R is also the seller column**, so 087 `Modify` overwrites `Refund-ed` in Manual R with a seller name.
2. Refund rows (085) copy the whole original row including D `-…` and S. A refund of an unbilled partner sale
   therefore shows up in Pending as an extra "cost" line equal to the refund amount.
3. The `"Payment to Partner"` vs `"Paid to Partner"` mismatch (§4.1): the commission section never appears.
4. The commission sign differs between the server (price − cost) and the client (cost − price). Qty is ignored in every total and PDF, while L
   is treated as a unit cost on the server (`cost*qty`). Check whether L/"Theorical cost" are unit or line totals before
   rebuilding (the observed payment row has L = 6 × J).
5. In settle, the per-partner keys collapse (one amount lost). All payment rows of one settlement share one ms timestamp,
   so O is not unique.
6. `updateEntriesColumnS` writes without an unlock. Settling is therefore non-atomic and repeatable, which gives duplicate payment rows.
7. The bill ID has no year and minute granularity, and can be split across a minute boundary. Bill list sorting is broken.
8. The Price edits in the dialogs are never persisted. Cost edits overwrite L with no history except the alert email
   (whose Qty and New Price fields are `undefined`).
9. In the Create Bill race, the 1.5 s timeout and the blocking `alert` let the two writers interleave on Temp2.
10. The settle flow's bogus write targets col E (Qty) with `"paid"` (it never matches). The protection unlock is skipped for the S write.
11. Entries Manual payment mirror overwrites the formula cells F,G,J,K with values and puts `To agent`/`From agent` in I.
12. `formatDate` is defined 5× (the last one wins and throws on strings). Day and month swap in `enforceDateFormat` (PDF/Temp2 only).
13. 087's Price fallback misses `""`, a non-listed seller silently becomes the first option, and every row is emailed on Modify.
14. Temp/Temp2/Temp3 are shared global scratch sheets, so two users at the same time corrupt each other.

## 12. Rebuild checklist (exact rows to produce)
- **Bill line update:** Entries L = final cost (only if edited/non-empty) and S = `B_dd/MM-HH:mm` (one ID per bill,
  computed once). Mirror through the normal Entries→Manual sync.
- **Settle:** one row per partner object with the net amount (combine both sections correctly). Entries layout as in §8.2c
  (`Settled` in S, `Payment to Partner`/`Payment From Partner` in M, a unique 17-digit O). Entries Manual layout:
  A..E,H,L,M,N same; I = `To agent`/`From agent`; O = author; Q = timestamp; P comment ""; leave F,G,J,K formulas.
  Then set the bill's lines' S to `Paid`. Make it idempotent (refuse if the bill's lines are no longer `B_…`).
- **Delete bill:** clear S on the lines with that ID (do not touch L).
- **Statuses:** `""`, `B_…`, `Paid`, `Settled`. Guest markers: `Payment to Partner`, `Payment From Partner`.
  Payment type excluded from settle: `Paid to Partner`.
- **Emails, if kept:** bill → user + `therabbittreegilimeno@gmail.com`; settlement → also
  `rabbittree.system.alerts.com@gmail.com`; cost modification → `rabbittree.system.alerts.com@gmail.com`;
  seller change → Protect!B2:B10.
