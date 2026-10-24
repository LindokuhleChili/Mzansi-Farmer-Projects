/*------------------------------------------------------------------------
  coop.i - co-op rules and routes, compiled as part of farm-api.p.

  Do not run this file on its own. It implements the same behaviour as
  mock-pasoe/coop-rules.js and mock-pasoe/coop-handler.js (docs/COOP.md).

  Money is integer cents inside the rules and DECIMAL(2) Rand in the database
  and in JSON. Quantities are whole kilograms. Pro rata uses the largest
  remainder method on INT64 so products such as 1960000 * 1200 do not overflow
  a 32-bit INTEGER. No ampersand placeholders: this file is an include.
------------------------------------------------------------------------*/

/* ---------- small helpers ---------- */
FUNCTION fEq RETURNS LOGICAL (INPUT pcA AS CHARACTER, INPUT pcB AS CHARACTER):
    IF pcA = ? OR pcB = ? THEN RETURN FALSE.
    RETURN COMPARE(pcA, "EQ", pcB, "CASE-SENSITIVE").
END FUNCTION.

FUNCTION fIsActiveAlloc RETURNS LOGICAL (INPUT pc AS CHARACTER):
    RETURN fEq(pc, "pending_approval") OR fEq(pc, "approved") OR fEq(pc, "delivered").
END FUNCTION.

FUNCTION fIsCommittedPayout RETURNS LOGICAL (INPUT pc AS CHARACTER):
    RETURN fEq(pc, "pending_approval") OR fEq(pc, "approved").
END FUNCTION.

/* Whole integer path or query token, or ? when it is not an optional minus and digits. */
FUNCTION fPathId RETURNS INTEGER (INPUT pc AS CHARACTER):
    DEFINE VARIABLE i   AS INTEGER   NO-UNDO.
    DEFINE VARIABLE k   AS INTEGER   NO-UNDO.
    DEFINE VARIABLE cCh AS CHARACTER NO-UNDO.
    IF pc = ? OR pc = "" OR pc = "-" THEN RETURN ?.
    DO k = 1 TO LENGTH(pc):
        cCh = SUBSTRING(pc, k, 1).
        IF k = 1 AND cCh = "-" THEN NEXT.
        IF INDEX("0123456789", cCh) = 0 THEN RETURN ?.
    END.
    i = INTEGER(pc) NO-ERROR.
    IF ERROR-STATUS:ERROR THEN RETURN ?.
    RETURN i.
END FUNCTION.

FUNCTION fToCents RETURNS INT64 (INPUT pd AS DECIMAL):
    DEFINE VARIABLE i AS INT64 NO-UNDO.
    IF pd = ? THEN RETURN 0.
    i = ROUND(pd * 100, 0).
    RETURN i.
END FUNCTION.

FUNCTION fCentsToDec RETURNS DECIMAL (INPUT piCents AS INT64):
    DEFINE VARIABLE d AS DECIMAL NO-UNDO.
    d = piCents.
    RETURN d / 100.
END FUNCTION.

/* Digits only. STRING() would use the session format and insert spaces or commas. */
FUNCTION fPlain RETURNS CHARACTER (INPUT pi AS INT64):
    DEFINE VARIABLE c     AS CHARACTER NO-UNDO.
    DEFINE VARIABLE i     AS INT64     NO-UNDO.
    DEFINE VARIABLE iDig  AS INTEGER   NO-UNDO.
    DEFINE VARIABLE cSign AS CHARACTER NO-UNDO INITIAL "".
    IF pi = ? THEN RETURN "?".
    IF pi < 0 THEN ASSIGN cSign = "-" i = - pi.
    ELSE i = pi.
    IF i = 0 THEN RETURN cSign + "0".
    c = "".
    DO WHILE i > 0:
        iDig = INTEGER(i MODULO 10).
        c = SUBSTRING("0123456789", iDig + 1, 1) + c.
        i = TRUNCATE(i / 10, 0).
    END.
    RETURN cSign + c.
END FUNCTION.

/* "R1600.00", matching JS toFixed(2). Negative amounts are "R-1.00". */
FUNCTION fRand RETURNS CHARACTER (INPUT piCents AS INT64):
    DEFINE VARIABLE iAbs   AS INT64     NO-UNDO.
    DEFINE VARIABLE iWhole AS INT64     NO-UNDO.
    DEFINE VARIABLE iFrac  AS INTEGER   NO-UNDO.
    DEFINE VARIABLE cFrac  AS CHARACTER NO-UNDO.
    DEFINE VARIABLE cSign  AS CHARACTER NO-UNDO INITIAL "".
    IF piCents < 0 THEN ASSIGN cSign = "-" iAbs = - piCents.
    ELSE iAbs = piCents.
    iWhole = TRUNCATE(iAbs / 100, 0).
    iFrac = INTEGER(iAbs MODULO 100).
    cFrac = fPlain(iFrac).
    IF LENGTH(cFrac) < 2 THEN cFrac = "0" + cFrac.
    RETURN "R" + cSign + fPlain(iWhole) + "." + cFrac.
END FUNCTION.

FUNCTION fReasonsJson RETURNS JsonArray (INPUT pc AS CHARACTER):
    DEFINE VARIABLE oParser AS ObjectModelParser NO-UNDO.
    IF pc = ? OR TRIM(pc) = "" THEN RETURN NEW JsonArray().
    oParser = NEW ObjectModelParser().
    RETURN CAST(oParser:Parse(pc), JsonArray).
END FUNCTION.

PROCEDURE p-add-dt:
    DEFINE INPUT PARAMETER po     AS JsonObject NO-UNDO.
    DEFINE INPUT PARAMETER pcName AS CHARACTER  NO-UNDO.
    DEFINE INPUT PARAMETER pt     AS DATETIME-TZ NO-UNDO.
    IF pt = ? THEN po:AddNull(pcName).
    ELSE po:Add(pcName, fIso(pt)).
END PROCEDURE.

PROCEDURE p-add-reason-x:
    DEFINE INPUT PARAMETER poArr     AS JsonArray NO-UNDO.
    DEFINE INPUT PARAMETER pcCode    AS CHARACTER NO-UNDO.
    DEFINE INPUT PARAMETER pcMsg     AS CHARACTER NO-UNDO.
    DEFINE INPUT PARAMETER pcSugName AS CHARACTER NO-UNDO.
    DEFINE INPUT PARAMETER pdSug     AS DECIMAL   NO-UNDO.
    DEFINE VARIABLE jo AS JsonObject NO-UNDO.
    jo = NEW JsonObject().
    jo:Add("code", pcCode).
    jo:Add("message", pcMsg).
    IF pcSugName <> "" THEN jo:Add(pcSugName, pdSug).
    poArr:Add(jo).
END PROCEDURE.

PROCEDURE p-reasons-text:
    DEFINE INPUT  PARAMETER poResult AS JsonObject NO-UNDO.
    DEFINE OUTPUT PARAMETER pcText   AS CHARACTER  NO-UNDO.
    DEFINE VARIABLE lc AS LONGCHAR NO-UNDO.
    lc = "".
    poResult:GetJsonArray("rejectReasons"):Write(INPUT-OUTPUT lc, FALSE).
    pcText = SUBSTRING(STRING(lc), 1, 2000).
END PROCEDURE.

PROCEDURE p-facts-copy:
    DEFINE INPUT  PARAMETER poResult AS JsonObject NO-UNDO.
    DEFINE OUTPUT PARAMETER poFacts  AS JsonObject NO-UNDO.
    DEFINE VARIABLE lc AS LONGCHAR NO-UNDO.
    DEFINE VARIABLE oParser AS ObjectModelParser NO-UNDO.
    lc = "".
    poResult:GetJsonObject("facts"):Write(INPUT-OUTPUT lc, FALSE).
    oParser = NEW ObjectModelParser().
    poFacts = CAST(oParser:Parse(lc), JsonObject).
END PROCEDURE.

PROCEDURE p-reply-named:
    DEFINE INPUT PARAMETER pcName AS CHARACTER NO-UNDO.
    DEFINE INPUT PARAMETER poArr  AS JsonArray NO-UNDO.
    DEFINE VARIABLE jo AS JsonObject NO-UNDO.
    jo = NEW JsonObject().
    jo:Add(pcName, poArr).
    RUN reply (200, jo).
END PROCEDURE.

PROCEDURE p-query-int:
    DEFINE INPUT  PARAMETER pcName AS CHARACTER NO-UNDO.
    DEFINE OUTPUT PARAMETER piVal  AS INTEGER   NO-UNDO.
    DEFINE OUTPUT PARAMETER pcMode AS CHARACTER NO-UNDO.
    DEFINE VARIABLE c AS CHARACTER NO-UNDO.
    c = fQuery(pcName).
    IF c = ? THEN DO:
        pcMode = "absent".
        RETURN.
    END.
    piVal = fPathId(c).
    IF piVal = ? THEN pcMode = "bad".
    ELSE pcMode = "ok".
END PROCEDURE.

PROCEDURE p-coop-common:
    DEFINE OUTPUT PARAMETER ptAsOf  AS DATETIME-TZ NO-UNDO.
    DEFINE OUTPUT PARAMETER pcReq   AS CHARACTER   NO-UNDO.
    DEFINE OUTPUT PARAMETER pcActor AS CHARACTER   NO-UNDO.
    DEFINE OUTPUT PARAMETER plOk    AS LOGICAL     NO-UNDO INITIAL FALSE.
    DEFINE VARIABLE cAsOf AS CHARACTER NO-UNDO.
    DEFINE VARIABLE lOk   AS LOGICAL   NO-UNDO.
    pcReq = "".
    pcActor = "farmer".
    RUN get-str (goBody, "requestId", OUTPUT pcReq, OUTPUT lOk).
    IF NOT lOk THEN pcReq = "".
    RUN get-str (goBody, "actor", OUTPUT pcActor, OUTPUT lOk).
    IF NOT lOk THEN pcActor = "farmer".
    ptAsOf = NOW.
    IF goBody:Has("asOf") THEN DO:
        RUN get-str (goBody, "asOf", OUTPUT cAsOf, OUTPUT lOk).
        IF lOk THEN ptAsOf = fParseIso(cAsOf).
        IF NOT lOk OR ptAsOf = ? THEN DO:
            RUN reply-error (400, "VALIDATION_ERROR", "asOf must be ISO 8601 UTC.", "asOf").
            RETURN.
        END.
    END.
    plOk = TRUE.
END PROCEDURE.

PROCEDURE p-read-posint:
    DEFINE INPUT  PARAMETER pcField AS CHARACTER NO-UNDO.
    DEFINE INPUT  PARAMETER pcMsg   AS CHARACTER NO-UNDO.
    DEFINE INPUT  PARAMETER piMax   AS INTEGER   NO-UNDO.
    DEFINE OUTPUT PARAMETER piVal   AS INTEGER   NO-UNDO.
    DEFINE OUTPUT PARAMETER plOk    AS LOGICAL   NO-UNDO INITIAL FALSE.
    DEFINE VARIABLE d   AS DECIMAL NO-UNDO.
    DEFINE VARIABLE lOk AS LOGICAL NO-UNDO.
    RUN get-num (goBody, pcField, OUTPUT d, OUTPUT lOk).
    IF NOT lOk OR d <> TRUNCATE(d, 0) OR d < 1 OR d > piMax THEN DO:
        RUN reply-error (400, "VALIDATION_ERROR", pcMsg, pcField).
        RETURN.
    END.
    piVal = INTEGER(d).
    plOk = TRUE.
END PROCEDURE.

/* pcMode: required-positive | optional-positive | optional-nonneg */
PROCEDURE p-read-money:
    DEFINE INPUT  PARAMETER pcField AS CHARACTER NO-UNDO.
    DEFINE INPUT  PARAMETER pcMsg   AS CHARACTER NO-UNDO.
    DEFINE INPUT  PARAMETER pcMode  AS CHARACTER NO-UNDO.
    DEFINE OUTPUT PARAMETER piCents AS INT64     NO-UNDO.
    DEFINE OUTPUT PARAMETER plSet   AS LOGICAL   NO-UNDO INITIAL FALSE.
    DEFINE OUTPUT PARAMETER plOk    AS LOGICAL   NO-UNDO INITIAL FALSE.
    DEFINE VARIABLE d   AS DECIMAL NO-UNDO.
    DEFINE VARIABLE lOk AS LOGICAL NO-UNDO.
    IF NOT goBody:Has(pcField) THEN DO:
        IF pcMode = "required-positive" THEN
            RUN reply-error (400, "VALIDATION_ERROR", pcMsg, pcField).
        ELSE ASSIGN plOk = TRUE plSet = FALSE.
        RETURN.
    END.
    plSet = TRUE.
    RUN get-num (goBody, pcField, OUTPUT d, OUTPUT lOk).
    IF NOT lOk OR d <> ROUND(d, 2) OR d > {&MAX_AMOUNT_RAND} THEN DO:
        RUN reply-error (400, "VALIDATION_ERROR", pcMsg, pcField).
        RETURN.
    END.
    IF pcMode = "optional-nonneg" THEN DO:
        IF d < 0 THEN DO:
            RUN reply-error (400, "VALIDATION_ERROR", pcMsg, pcField).
            RETURN.
        END.
    END.
    ELSE IF d <= 0 THEN DO:
        RUN reply-error (400, "VALIDATION_ERROR", pcMsg, pcField).
        RETURN.
    END.
    piCents = fToCents(d).
    plOk = TRUE.
END PROCEDURE.

/* ---------- pro rata (largest remainder), exact integer maths ---------- */
PROCEDURE p-dist-reset:
    EMPTY TEMP-TABLE ttDist.
END PROCEDURE.

PROCEDURE p-dist-add:
    DEFINE INPUT PARAMETER piId     AS INTEGER NO-UNDO.
    DEFINE INPUT PARAMETER piWeight AS INT64   NO-UNDO.
    CREATE ttDist.
    ASSIGN ttDist.itemId  = piId
           ttDist.weight  = piWeight
           ttDist.baseAmt = 0
           ttDist.frac    = 0.
END PROCEDURE.

PROCEDURE p-dist-run:
    DEFINE INPUT PARAMETER piTotal AS INT64 NO-UNDO.
    DEFINE VARIABLE iSumW    AS INT64 NO-UNDO INITIAL 0.
    DEFINE VARIABLE iProd    AS INT64 NO-UNDO.
    DEFINE VARIABLE iBaseSum AS INT64 NO-UNDO INITIAL 0.
    DEFINE VARIABLE iLeft    AS INT64 NO-UNDO.
    FOR EACH ttDist:
        iSumW = iSumW + ttDist.weight.
    END.
    IF iSumW = 0 OR piTotal <= 0 THEN DO:
        FOR EACH ttDist:
            ttDist.baseAmt = 0.
        END.
        RETURN.
    END.
    FOR EACH ttDist:
        /* INT64 multiply: 1960000 cents * 1200 kg does not fit in INTEGER. */
        iProd = piTotal * ttDist.weight.
        ASSIGN ttDist.baseAmt = iProd / iSumW
               ttDist.frac    = iProd MODULO iSumW.
        iBaseSum = iBaseSum + ttDist.baseAmt.
    END.
    iLeft = piTotal - iBaseSum.
    /* Biggest remainder first. Equal remainders: lowest id (itemId ascending). */
    FOR EACH ttDist BY ttDist.frac DESCENDING BY ttDist.itemId:
        IF iLeft <= 0 THEN LEAVE.
        ASSIGN ttDist.baseAmt = ttDist.baseAmt + 1
               iLeft = iLeft - 1.
    END.
END PROCEDURE.

FUNCTION fDistGet RETURNS INT64 (INPUT piId AS INTEGER):
    FIND ttDist WHERE ttDist.itemId = piId NO-ERROR.
    IF AVAILABLE ttDist THEN RETURN ttDist.baseAmt.
    RETURN 0.
END FUNCTION.

/* ---------- sums (named buffers so a caller's FIND is not moved) ---------- */
PROCEDURE p-outstanding:
    DEFINE INPUT  PARAMETER piMember AS INTEGER NO-UNDO.
    DEFINE INPUT  PARAMETER piExcl   AS INTEGER NO-UNDO.
    DEFINE OUTPUT PARAMETER piOut    AS INT64   NO-UNDO.
    DEFINE BUFFER bCr FOR InputCredit.
    piOut = 0.
    FOR EACH bCr NO-LOCK WHERE bCr.MemberId = piMember:
        IF bCr.CreditId = piExcl THEN NEXT.
        IF fEq(bCr.CreditStatus, "approved") THEN
            piOut = piOut + fToCents(bCr.Amount) - fToCents(bCr.RepaidAmount).
        ELSE IF fEq(bCr.CreditStatus, "pending_approval") THEN
            piOut = piOut + fToCents(bCr.Amount).
    END.
END PROCEDURE.

PROCEDURE p-deductible:
    DEFINE INPUT  PARAMETER piMember AS INTEGER NO-UNDO.
    DEFINE INPUT  PARAMETER piExcl   AS INTEGER NO-UNDO.
    DEFINE OUTPUT PARAMETER piOut    AS INT64   NO-UNDO.
    DEFINE BUFFER bCr FOR InputCredit.
    DEFINE BUFFER bP  FOR Payout.
    piOut = 0.
    FOR EACH bCr NO-LOCK WHERE bCr.MemberId = piMember:
        IF fEq(bCr.CreditStatus, "approved") THEN
            piOut = piOut + fToCents(bCr.Amount) - fToCents(bCr.RepaidAmount).
    END.
    FOR EACH bP NO-LOCK WHERE bP.MemberId = piMember:
        IF bP.PayoutId = piExcl THEN NEXT.
        IF fEq(bP.PayoutStatus, "pending_approval") THEN
            piOut = piOut - fToCents(bP.CreditDeducted).
    END.
    IF piOut < 0 THEN piOut = 0.
END PROCEDURE.

PROCEDURE p-lot-alloc-kg:
    DEFINE INPUT  PARAMETER piLot  AS INTEGER NO-UNDO.
    DEFINE INPUT  PARAMETER piExcl AS INTEGER NO-UNDO.
    DEFINE OUTPUT PARAMETER piKg   AS INTEGER NO-UNDO.
    DEFINE BUFFER bA FOR Allocation.
    piKg = 0.
    FOR EACH bA NO-LOCK WHERE bA.LotId = piLot:
        IF bA.AllocationId = piExcl THEN NEXT.
        IF fIsActiveAlloc(bA.AllocStatus) THEN piKg = piKg + bA.Kg.
    END.
END PROCEDURE.

PROCEDURE p-contract-alloc-kg:
    DEFINE INPUT  PARAMETER piCon  AS INTEGER NO-UNDO.
    DEFINE INPUT  PARAMETER piExcl AS INTEGER NO-UNDO.
    DEFINE OUTPUT PARAMETER piKg   AS INTEGER NO-UNDO.
    DEFINE BUFFER bA FOR Allocation.
    piKg = 0.
    FOR EACH bA NO-LOCK WHERE bA.ContractId = piCon:
        IF bA.AllocationId = piExcl THEN NEXT.
        IF fIsActiveAlloc(bA.AllocStatus) THEN piKg = piKg + bA.Kg.
    END.
END PROCEDURE.

PROCEDURE p-delivered:
    DEFINE INPUT  PARAMETER piLot   AS INTEGER NO-UNDO.
    DEFINE OUTPUT PARAMETER piKg    AS INTEGER NO-UNDO.
    DEFINE OUTPUT PARAMETER piValue AS INT64   NO-UNDO.
    DEFINE BUFFER bA FOR Allocation.
    piKg = 0.
    piValue = 0.
    FOR EACH bA NO-LOCK WHERE bA.LotId = piLot:
        IF NOT fEq(bA.AllocStatus, "delivered") THEN NEXT.
        piKg = piKg + bA.Kg.
        piValue = piValue + (INT64(bA.Kg) * fToCents(bA.PricePerKg)).
    END.
END PROCEDURE.

PROCEDURE p-committed-gross:
    DEFINE INPUT  PARAMETER piLot    AS INTEGER NO-UNDO.
    DEFINE INPUT  PARAMETER piMember AS INTEGER NO-UNDO.
    DEFINE INPUT  PARAMETER piExcl   AS INTEGER NO-UNDO.
    DEFINE OUTPUT PARAMETER piCents  AS INT64   NO-UNDO.
    DEFINE BUFFER bP FOR Payout.
    piCents = 0.
    FOR EACH bP NO-LOCK WHERE bP.LotId = piLot AND bP.MemberId = piMember:
        IF bP.PayoutId = piExcl THEN NEXT.
        IF fIsCommittedPayout(bP.PayoutStatus) THEN
            piCents = piCents + fToCents(bP.GrossAmount).
    END.
END PROCEDURE.

PROCEDURE p-contrib:
    DEFINE INPUT  PARAMETER piLot    AS INTEGER NO-UNDO.
    DEFINE INPUT  PARAMETER piMember AS INTEGER NO-UNDO.
    DEFINE OUTPUT PARAMETER piKg     AS INTEGER NO-UNDO.
    DEFINE OUTPUT PARAMETER plFound  AS LOGICAL NO-UNDO.
    DEFINE BUFFER bC FOR LotContribution.
    FIND bC WHERE bC.LotId = piLot AND bC.MemberId = piMember NO-LOCK NO-ERROR.
    IF AVAILABLE bC THEN ASSIGN piKg = bC.Kg plFound = TRUE.
    ELSE ASSIGN piKg = 0 plFound = FALSE.
END PROCEDURE.

PROCEDURE p-member-share-cents:
    DEFINE INPUT  PARAMETER piLot    AS INTEGER NO-UNDO.
    DEFINE INPUT  PARAMETER piMember AS INTEGER NO-UNDO.
    DEFINE OUTPUT PARAMETER piShare  AS INT64   NO-UNDO.
    DEFINE VARIABLE iKg  AS INTEGER NO-UNDO.
    DEFINE VARIABLE iVal AS INT64   NO-UNDO.
    DEFINE BUFFER bC FOR LotContribution.
    RUN p-delivered (piLot, OUTPUT iKg, OUTPUT iVal).
    RUN p-dist-reset.
    FOR EACH bC NO-LOCK WHERE bC.LotId = piLot:
        RUN p-dist-add (bC.MemberId, INT64(bC.Kg)).
    END.
    RUN p-dist-run (iVal).
    piShare = fDistGet(piMember).
END PROCEDURE.

/* ---------- the rules ---------- */
PROCEDURE p-check-credit:
    DEFINE INPUT  PARAMETER piMember AS INTEGER    NO-UNDO.
    DEFINE INPUT  PARAMETER piAmount AS INT64      NO-UNDO.
    DEFINE INPUT  PARAMETER piExcl   AS INTEGER    NO-UNDO.
    DEFINE OUTPUT PARAMETER poResult AS JsonObject NO-UNDO.
    DEFINE BUFFER bMem FOR CoopMember.
    DEFINE VARIABLE iOut   AS INT64     NO-UNDO.
    DEFINE VARIABLE iLimit AS INT64     NO-UNDO.
    DEFINE VARIABLE iHead  AS INT64     NO-UNDO.
    DEFINE VARIABLE ja     AS JsonArray NO-UNDO.
    DEFINE VARIABLE joF    AS JsonObject NO-UNDO.
    FIND bMem WHERE bMem.MemberId = piMember NO-LOCK NO-ERROR.
    iLimit = fToCents(bMem.CreditLimit).
    RUN p-outstanding (piMember, piExcl, OUTPUT iOut).
    iHead = iLimit - iOut.
    IF iHead < 0 THEN iHead = 0.
    ja = NEW JsonArray().
    joF = NEW JsonObject().
    joF:Add("memberId", piMember).
    joF:Add("memberName", bMem.MemberName).
    joF:Add("creditLimit", fCentsToDec(iLimit)).
    joF:Add("outstandingCredit", fCentsToDec(iOut)).
    joF:Add("availableCredit", fCentsToDec(iHead)).
    joF:Add("requestedAmount", fCentsToDec(piAmount)).
    IF iOut + piAmount > iLimit THEN
        RUN p-add-reason-x (ja, "CREDIT_LIMIT_EXCEEDED",
            "Credit of " + fRand(piAmount) + " plus " + fRand(iOut)
            + " already committed is above the member limit of " + fRand(iLimit)
            + ". Reduce to " + fRand(iHead) + ".",
            "suggestedAmount", fCentsToDec(iHead)).
    poResult = NEW JsonObject().
    poResult:Add("verdict", (IF ja:Length = 0 THEN "approved_by_rules" ELSE "rejected_by_rules")).
    poResult:Add("rejectReasons", ja).
    poResult:Add("facts", joF).
END PROCEDURE.

PROCEDURE p-check-alloc:
    DEFINE INPUT  PARAMETER piLot    AS INTEGER    NO-UNDO.
    DEFINE INPUT  PARAMETER piCon    AS INTEGER    NO-UNDO.
    DEFINE INPUT  PARAMETER piKg     AS INTEGER    NO-UNDO.
    DEFINE INPUT  PARAMETER piExcl   AS INTEGER    NO-UNDO.
    DEFINE OUTPUT PARAMETER poResult AS JsonObject NO-UNDO.
    DEFINE BUFFER bL FOR HarvestLot.
    DEFINE BUFFER bC FOR BuyerContract.
    DEFINE VARIABLE iLotAlloc AS INTEGER NO-UNDO.
    DEFINE VARIABLE iConAlloc AS INTEGER NO-UNDO.
    DEFINE VARIABLE iLotAvail AS INTEGER NO-UNDO.
    DEFINE VARIABLE iConRem   AS INTEGER NO-UNDO.
    DEFINE VARIABLE iSug      AS INTEGER NO-UNDO.
    DEFINE VARIABLE ja        AS JsonArray NO-UNDO.
    DEFINE VARIABLE joF       AS JsonObject NO-UNDO.
    FIND bL WHERE bL.LotId = piLot NO-LOCK.
    FIND bC WHERE bC.ContractId = piCon NO-LOCK.
    RUN p-lot-alloc-kg (piLot, piExcl, OUTPUT iLotAlloc).
    RUN p-contract-alloc-kg (piCon, piExcl, OUTPUT iConAlloc).
    iLotAvail = bL.QuantityKg - iLotAlloc.
    IF iLotAvail < 0 THEN iLotAvail = 0.
    iConRem = bC.QuantityKg - iConAlloc.
    IF iConRem < 0 THEN iConRem = 0.
    iSug = MINIMUM(iLotAvail, iConRem).
    ja = NEW JsonArray().
    joF = NEW JsonObject().
    joF:Add("lotCode", bL.LotCode).
    joF:Add("contractCode", bC.ContractCode).
    joF:Add("crop", bL.Crop).
    joF:Add("lotQuantityKg", bL.QuantityKg).
    joF:Add("lotAllocatedKg", iLotAlloc).
    joF:Add("lotAvailableKg", iLotAvail).
    joF:Add("contractQuantityKg", bC.QuantityKg).
    joF:Add("contractAllocatedKg", iConAlloc).
    joF:Add("contractRemainingKg", iConRem).
    joF:Add("requestedKg", piKg).
    IF LC(bL.Crop) <> LC(bC.Crop) THEN
        RUN p-add-reason-x (ja, "CROP_MISMATCH",
            "Lot " + bL.LotCode + " is " + bL.Crop + " but contract " + bC.ContractCode + " is for " + bC.Crop + ".",
            "", 0).
    IF NOT fEq(bC.ContractStatus, "open") THEN
        RUN p-add-reason-x (ja, "CONTRACT_CLOSED",
            "Contract " + bC.ContractCode + " is " + bC.ContractStatus + ".",
            "", 0).
    IF piKg > iConRem THEN
        RUN p-add-reason-x (ja, "LOT_EXCEEDS_CONTRACT",
            fPlain(piKg) + " kg is above the " + fPlain(iConRem) + " kg still open on contract "
            + bC.ContractCode + ". Allocate " + fPlain(iSug) + " kg.",
            "suggestedKg", iSug).
    IF piKg > iLotAvail THEN
        RUN p-add-reason-x (ja, "LOT_STOCK_EXCEEDED",
            fPlain(piKg) + " kg is above the " + fPlain(iLotAvail) + " kg of lot "
            + bL.LotCode + " not yet allocated. Allocate " + fPlain(iSug) + " kg.",
            "suggestedKg", iSug).
    poResult = NEW JsonObject().
    poResult:Add("verdict", (IF ja:Length = 0 THEN "approved_by_rules" ELSE "rejected_by_rules")).
    poResult:Add("rejectReasons", ja).
    poResult:Add("facts", joF).
END PROCEDURE.

PROCEDURE p-check-payout:
    DEFINE INPUT  PARAMETER piLot    AS INTEGER    NO-UNDO.
    DEFINE INPUT  PARAMETER piMember AS INTEGER    NO-UNDO.
    DEFINE INPUT  PARAMETER piGross  AS INT64      NO-UNDO.
    DEFINE INPUT  PARAMETER piDeduct AS INT64      NO-UNDO.
    DEFINE INPUT  PARAMETER piExcl   AS INTEGER    NO-UNDO.
    DEFINE OUTPUT PARAMETER poResult AS JsonObject NO-UNDO.
    DEFINE BUFFER bL FOR HarvestLot.
    DEFINE VARIABLE iContribKg AS INTEGER NO-UNDO.
    DEFINE VARIABLE lContrib   AS LOGICAL NO-UNDO.
    DEFINE VARIABLE iDelKg     AS INTEGER NO-UNDO.
    DEFINE VARIABLE iDelVal    AS INT64   NO-UNDO.
    DEFINE VARIABLE iShare     AS INT64   NO-UNDO.
    DEFINE VARIABLE iCommitted AS INT64   NO-UNDO.
    DEFINE VARIABLE iRemain    AS INT64   NO-UNDO.
    DEFINE VARIABLE iOpen      AS INT64   NO-UNDO.
    DEFINE VARIABLE iRequired  AS INT64   NO-UNDO.
    DEFINE VARIABLE ja         AS JsonArray  NO-UNDO.
    DEFINE VARIABLE joF        AS JsonObject NO-UNDO.
    FIND bL WHERE bL.LotId = piLot NO-LOCK.
    RUN p-contrib (piLot, piMember, OUTPUT iContribKg, OUTPUT lContrib).
    RUN p-delivered (piLot, OUTPUT iDelKg, OUTPUT iDelVal).
    IF lContrib THEN RUN p-member-share-cents (piLot, piMember, OUTPUT iShare).
    ELSE iShare = 0.
    RUN p-committed-gross (piLot, piMember, piExcl, OUTPUT iCommitted).
    iRemain = iShare - iCommitted.
    IF iRemain < 0 THEN iRemain = 0.
    RUN p-deductible (piMember, piExcl, OUTPUT iOpen).
    iRequired = iOpen.
    IF iRequired > piGross THEN iRequired = piGross.
    ja = NEW JsonArray().
    joF = NEW JsonObject().
    joF:Add("lotCode", bL.LotCode).
    joF:Add("memberId", piMember).
    joF:Add("contributedKg", iContribKg).
    joF:Add("deliveredKg", iDelKg).
    joF:Add("deliveredValue", fCentsToDec(iDelVal)).
    joF:Add("memberShare", fCentsToDec(iShare)).
    joF:Add("alreadyCommitted", fCentsToDec(iCommitted)).
    joF:Add("remainingShare", fCentsToDec(iRemain)).
    joF:Add("openCredit", fCentsToDec(iOpen)).
    joF:Add("requestedGross", fCentsToDec(piGross)).
    joF:Add("creditDeducted", fCentsToDec(piDeduct)).
    joF:Add("net", fCentsToDec(piGross - piDeduct)).
    IF NOT lContrib THEN
        RUN p-add-reason-x (ja, "MEMBER_NOT_IN_LOT",
            "Member " + fPlain(piMember) + " did not contribute to lot " + bL.LotCode + ".",
            "", 0).
    IF iDelKg = 0 THEN
        RUN p-add-reason-x (ja, "PAYOUT_NOT_DELIVERED",
            "Lot " + bL.LotCode + " has no delivered allocation yet; nothing can be paid out.",
            "", 0).
    ELSE IF lContrib AND piGross = 0 THEN
        RUN p-add-reason-x (ja, "PAYOUT_NOTHING_DUE",
            "The member's share of lot " + bL.LotCode + " has already been paid or is waiting for approval.",
            "", 0).
    IF lContrib AND piGross > iRemain THEN
        RUN p-add-reason-x (ja, "PAYOUT_EXCEEDS_SHARE",
            "Gross " + fRand(piGross) + " is above the member's remaining share of " + fRand(iRemain)
            + " (share " + fRand(iShare) + " of delivered value " + fRand(iDelVal) + ").",
            "suggestedGrossAmount", fCentsToDec(iRemain)).
    IF piDeduct > iOpen OR piDeduct > piGross THEN
        RUN p-add-reason-x (ja, "CREDIT_DEDUCTION_INVALID",
            "Credit deducted " + fRand(piDeduct) + " must not be above the open credit " + fRand(iOpen)
            + " or the gross " + fRand(piGross) + ". Deduct " + fRand(iRequired) + ".",
            "suggestedCreditDeducted", fCentsToDec(iRequired)).
    ELSE IF piDeduct < iRequired THEN
        RUN p-add-reason-x (ja, "CREDIT_NOT_DEDUCTED",
            "The member has " + fRand(iOpen) + " open credit; " + fRand(iRequired)
            + " must be deducted from this payout, not " + fRand(piDeduct) + ".",
            "suggestedCreditDeducted", fCentsToDec(iRequired)).
    poResult = NEW JsonObject().
    poResult:Add("verdict", (IF ja:Length = 0 THEN "approved_by_rules" ELSE "rejected_by_rules")).
    poResult:Add("rejectReasons", ja).
    poResult:Add("facts", joF).
END PROCEDURE.

PROCEDURE p-fair-plan:
    DEFINE INPUT  PARAMETER piLot  AS INTEGER    NO-UNDO.
    DEFINE OUTPUT PARAMETER poPlan AS JsonObject NO-UNDO.
    DEFINE BUFFER bL   FOR HarvestLot.
    DEFINE BUFFER bCon FOR BuyerContract.
    DEFINE VARIABLE iAlloc    AS INTEGER   NO-UNDO.
    DEFINE VARIABLE iAvail    AS INTEGER   NO-UNDO.
    DEFINE VARIABLE iDemand   AS INTEGER   NO-UNDO.
    DEFINE VARIABLE iConAlloc AS INTEGER   NO-UNDO.
    DEFINE VARIABLE iRem      AS INTEGER   NO-UNDO.
    DEFINE VARIABLE iPlanned  AS INTEGER   NO-UNDO.
    DEFINE VARIABLE cMethod   AS CHARACTER NO-UNDO.
    DEFINE VARIABLE ja        AS JsonArray NO-UNDO.
    DEFINE VARIABLE joA       AS JsonObject NO-UNDO.
    EMPTY TEMP-TABLE ttFair.
    FIND bL WHERE bL.LotId = piLot NO-LOCK.
    RUN p-lot-alloc-kg (piLot, 0, OUTPUT iAlloc).
    iAvail = bL.QuantityKg - iAlloc.
    IF iAvail < 0 THEN iAvail = 0.
    iDemand = 0.
    FOR EACH bCon NO-LOCK BY bCon.ContractId:
        IF NOT fEq(bCon.ContractStatus, "open") THEN NEXT.
        IF LC(bL.Crop) <> LC(bCon.Crop) THEN NEXT.
        RUN p-contract-alloc-kg (bCon.ContractId, 0, OUTPUT iConAlloc).
        iRem = bCon.QuantityKg - iConAlloc.
        IF iRem < 0 THEN iRem = 0.
        IF iRem = 0 THEN NEXT.
        CREATE ttFair.
        ASSIGN ttFair.contractId   = bCon.ContractId
               ttFair.contractCode = bCon.ContractCode
               ttFair.remainKg     = iRem
               ttFair.allocKg      = 0.
        iDemand = iDemand + iRem.
    END.
    cMethod = "none".
    IF iAvail > 0 AND iDemand > 0 THEN DO:
        IF iAvail >= iDemand THEN DO:
            cMethod = "full".
            FOR EACH ttFair:
                ttFair.allocKg = ttFair.remainKg.
            END.
        END.
        ELSE DO:
            cMethod = "pro_rata".
            RUN p-dist-reset.
            FOR EACH ttFair:
                RUN p-dist-add (ttFair.contractId, INT64(ttFair.remainKg)).
            END.
            RUN p-dist-run (INT64(iAvail)).
            FOR EACH ttFair:
                ttFair.allocKg = INTEGER(fDistGet(ttFair.contractId)).
            END.
        END.
    END.
    iPlanned = 0.
    ja = NEW JsonArray().
    FOR EACH ttFair BY ttFair.contractId:
        IF ttFair.allocKg <= 0 THEN NEXT.
        iPlanned = iPlanned + ttFair.allocKg.
        joA = NEW JsonObject().
        joA:Add("contractId", ttFair.contractId).
        joA:Add("contractCode", ttFair.contractCode).
        joA:Add("remainingKg", ttFair.remainKg).
        joA:Add("kg", ttFair.allocKg).
        ja:Add(joA).
    END.
    poPlan = NEW JsonObject().
    poPlan:Add("lotId", bL.LotId).
    poPlan:Add("lotCode", bL.LotCode).
    poPlan:Add("crop", bL.Crop).
    poPlan:Add("availableKg", iAvail).
    poPlan:Add("demandKg", iDemand).
    poPlan:Add("method", cMethod).
    poPlan:Add("allocations", ja).
    poPlan:Add("unallocatedKg", iAvail - iPlanned).
END PROCEDURE.

/* ---------- JSON builders ---------- */
FUNCTION fMemberJson RETURNS JsonObject (INPUT piId AS INTEGER):
    DEFINE BUFFER bMem FOR CoopMember.
    DEFINE VARIABLE jo     AS JsonObject NO-UNDO.
    DEFINE VARIABLE iOut   AS INT64 NO-UNDO.
    DEFINE VARIABLE iLim   AS INT64 NO-UNDO.
    DEFINE VARIABLE iAvail AS INT64 NO-UNDO.
    FIND bMem WHERE bMem.MemberId = piId NO-LOCK NO-ERROR.
    IF NOT AVAILABLE bMem THEN RETURN ?.
    RUN p-outstanding (piId, 0, OUTPUT iOut).
    iLim = fToCents(bMem.CreditLimit).
    iAvail = iLim - iOut.
    IF iAvail < 0 THEN iAvail = 0.
    jo = NEW JsonObject().
    jo:Add("memberId", bMem.MemberId).
    jo:Add("memberName", bMem.MemberName).
    jo:Add("location", bMem.Location).
    jo:Add("preferredLang", bMem.PreferredLang).
    jo:Add("creditLimit", fCentsToDec(iLim)).
    jo:Add("outstandingCredit", fCentsToDec(iOut)).
    jo:Add("availableCredit", fCentsToDec(iAvail)).
    RETURN jo.
END FUNCTION.

FUNCTION fCreditJson RETURNS JsonObject (INPUT piId AS INTEGER):
    DEFINE BUFFER bCr FOR InputCredit.
    DEFINE VARIABLE jo AS JsonObject NO-UNDO.
    FIND bCr WHERE bCr.CreditId = piId NO-LOCK NO-ERROR.
    IF NOT AVAILABLE bCr THEN RETURN ?.
    jo = NEW JsonObject().
    jo:Add("creditId", bCr.CreditId).
    jo:Add("memberId", bCr.MemberId).
    jo:Add("item", bCr.ItemName).
    jo:Add("amount", fCentsToDec(fToCents(bCr.Amount))).
    jo:Add("repaidAmount", fCentsToDec(fToCents(bCr.RepaidAmount))).
    jo:Add("status", bCr.CreditStatus).
    jo:Add("verdict", bCr.Verdict).
    jo:Add("rejectReasons", fReasonsJson(bCr.RejectReasons)).
    RUN p-add-dt (jo, "createdAt", bCr.CreatedAt).
    RUN p-add-dt (jo, "decidedAt", bCr.DecidedAt).
    jo:Add("requestId", bCr.RequestId).
    RETURN jo.
END FUNCTION.

FUNCTION fLotJson RETURNS JsonObject (INPUT piId AS INTEGER):
    DEFINE BUFFER bL FOR HarvestLot.
    DEFINE BUFFER bC FOR LotContribution.
    DEFINE VARIABLE jo     AS JsonObject NO-UNDO.
    DEFINE VARIABLE ja     AS JsonArray  NO-UNDO.
    DEFINE VARIABLE jc     AS JsonObject NO-UNDO.
    DEFINE VARIABLE iAlloc AS INTEGER NO-UNDO.
    DEFINE VARIABLE iAvail AS INTEGER NO-UNDO.
    DEFINE VARIABLE iDelKg AS INTEGER NO-UNDO.
    DEFINE VARIABLE iDelVal AS INT64  NO-UNDO.
    DEFINE VARIABLE iShare AS INT64   NO-UNDO.
    FIND bL WHERE bL.LotId = piId NO-LOCK NO-ERROR.
    IF NOT AVAILABLE bL THEN RETURN ?.
    RUN p-lot-alloc-kg (piId, 0, OUTPUT iAlloc).
    RUN p-delivered (piId, OUTPUT iDelKg, OUTPUT iDelVal).
    iAvail = bL.QuantityKg - iAlloc.
    IF iAvail < 0 THEN iAvail = 0.
    ja = NEW JsonArray().
    FOR EACH bC NO-LOCK WHERE bC.LotId = piId BY bC.MemberId:
        RUN p-member-share-cents (piId, bC.MemberId, OUTPUT iShare).
        jc = NEW JsonObject().
        jc:Add("memberId", bC.MemberId).
        jc:Add("kg", bC.Kg).
        jc:Add("share", fCentsToDec(iShare)).
        ja:Add(jc).
    END.
    jo = NEW JsonObject().
    jo:Add("lotId", bL.LotId).
    jo:Add("lotCode", bL.LotCode).
    jo:Add("crop", bL.Crop).
    jo:Add("quantityKg", bL.QuantityKg).
    jo:Add("allocatedKg", iAlloc).
    jo:Add("availableKg", iAvail).
    jo:Add("deliveredKg", iDelKg).
    jo:Add("deliveredValue", fCentsToDec(iDelVal)).
    jo:Add("contributions", ja).
    RETURN jo.
END FUNCTION.

FUNCTION fContractJson RETURNS JsonObject (INPUT piId AS INTEGER):
    DEFINE BUFFER bC FOR BuyerContract.
    DEFINE VARIABLE jo    AS JsonObject NO-UNDO.
    DEFINE VARIABLE iAlloc AS INTEGER NO-UNDO.
    DEFINE VARIABLE iRem   AS INTEGER NO-UNDO.
    FIND bC WHERE bC.ContractId = piId NO-LOCK NO-ERROR.
    IF NOT AVAILABLE bC THEN RETURN ?.
    RUN p-contract-alloc-kg (piId, 0, OUTPUT iAlloc).
    iRem = bC.QuantityKg - iAlloc.
    IF iRem < 0 THEN iRem = 0.
    jo = NEW JsonObject().
    jo:Add("contractId", bC.ContractId).
    jo:Add("contractCode", bC.ContractCode).
    jo:Add("buyerName", bC.BuyerName).
    jo:Add("crop", bC.Crop).
    jo:Add("quantityKg", bC.QuantityKg).
    jo:Add("pricePerKg", fCentsToDec(fToCents(bC.PricePerKg))).
    jo:Add("status", bC.ContractStatus).
    jo:Add("allocatedKg", iAlloc).
    jo:Add("remainingKg", iRem).
    RETURN jo.
END FUNCTION.

FUNCTION fAllocJson RETURNS JsonObject (INPUT piId AS INTEGER):
    DEFINE BUFFER bA FOR Allocation.
    DEFINE VARIABLE jo AS JsonObject NO-UNDO.
    DEFINE VARIABLE iPrice AS INT64 NO-UNDO.
    FIND bA WHERE bA.AllocationId = piId NO-LOCK NO-ERROR.
    IF NOT AVAILABLE bA THEN RETURN ?.
    iPrice = fToCents(bA.PricePerKg).
    jo = NEW JsonObject().
    jo:Add("allocationId", bA.AllocationId).
    jo:Add("lotId", bA.LotId).
    jo:Add("contractId", bA.ContractId).
    jo:Add("kg", bA.Kg).
    jo:Add("pricePerKg", fCentsToDec(iPrice)).
    jo:Add("value", fCentsToDec(INT64(bA.Kg) * iPrice)).
    jo:Add("status", bA.AllocStatus).
    jo:Add("verdict", bA.Verdict).
    jo:Add("rejectReasons", fReasonsJson(bA.RejectReasons)).
    RUN p-add-dt (jo, "createdAt", bA.CreatedAt).
    RUN p-add-dt (jo, "decidedAt", bA.DecidedAt).
    RUN p-add-dt (jo, "deliveredAt", bA.DeliveredAt).
    jo:Add("requestId", bA.RequestId).
    RETURN jo.
END FUNCTION.

FUNCTION fPayoutJson RETURNS JsonObject (INPUT piId AS INTEGER):
    DEFINE BUFFER bP FOR Payout.
    DEFINE VARIABLE jo AS JsonObject NO-UNDO.
    DEFINE VARIABLE iGross AS INT64 NO-UNDO.
    DEFINE VARIABLE iDed   AS INT64 NO-UNDO.
    FIND bP WHERE bP.PayoutId = piId NO-LOCK NO-ERROR.
    IF NOT AVAILABLE bP THEN RETURN ?.
    iGross = fToCents(bP.GrossAmount).
    iDed = fToCents(bP.CreditDeducted).
    jo = NEW JsonObject().
    jo:Add("payoutId", bP.PayoutId).
    jo:Add("lotId", bP.LotId).
    jo:Add("memberId", bP.MemberId).
    jo:Add("grossAmount", fCentsToDec(iGross)).
    jo:Add("creditDeducted", fCentsToDec(iDed)).
    jo:Add("netAmount", fCentsToDec(iGross - iDed)).
    jo:Add("status", bP.PayoutStatus).
    jo:Add("verdict", bP.Verdict).
    jo:Add("rejectReasons", fReasonsJson(bP.RejectReasons)).
    RUN p-add-dt (jo, "createdAt", bP.CreatedAt).
    RUN p-add-dt (jo, "decidedAt", bP.DecidedAt).
    jo:Add("requestId", bP.RequestId).
    RETURN jo.
END FUNCTION.

PROCEDURE p-not-found:
    DEFINE INPUT PARAMETER piId   AS INTEGER   NO-UNDO.
    DEFINE INPUT PARAMETER pcCode AS CHARACTER NO-UNDO.
    DEFINE INPUT PARAMETER pcWhat AS CHARACTER NO-UNDO.
    /* JS idOf() yields NaN for a non-numeric path segment, and the message uses that word. */
    IF piId = ? THEN RUN reply-error (404, pcCode, "No " + pcWhat + " with id NaN.", ?).
    ELSE RUN reply-error (404, pcCode, "No " + pcWhat + " with id " + fPlain(piId) + ".", ?).
END PROCEDURE.

PROCEDURE p-reply-one:
    DEFINE INPUT PARAMETER po    AS JsonObject NO-UNDO.
    DEFINE INPUT PARAMETER piId  AS INTEGER    NO-UNDO.
    DEFINE INPUT PARAMETER pcCode AS CHARACTER NO-UNDO.
    DEFINE INPUT PARAMETER pcWhat AS CHARACTER NO-UNDO.
    IF po = ? OR piId = ? THEN RUN p-not-found (piId, pcCode, pcWhat).
    ELSE RUN reply (200, po).
END PROCEDURE.

/* ---------- reads ---------- */
PROCEDURE h-coop-members:
    DEFINE VARIABLE ja AS JsonArray NO-UNDO.
    DEFINE BUFFER bM FOR CoopMember.
    ja = NEW JsonArray().
    FOR EACH bM NO-LOCK BY bM.MemberId:
        ja:Add(fMemberJson(bM.MemberId)).
    END.
    RUN p-reply-named ("members", ja).
END PROCEDURE.

PROCEDURE h-coop-member:
    DEFINE INPUT PARAMETER piId AS INTEGER NO-UNDO.
    RUN p-reply-one (fMemberJson(piId), piId, "MEMBER_NOT_FOUND", "member").
END PROCEDURE.

PROCEDURE h-coop-credits:
    DEFINE VARIABLE ja       AS JsonArray NO-UNDO.
    DEFINE VARIABLE iMid     AS INTEGER   NO-UNDO.
    DEFINE VARIABLE cMode    AS CHARACTER NO-UNDO.
    DEFINE VARIABLE cStatus  AS CHARACTER NO-UNDO.
    DEFINE BUFFER bC FOR InputCredit.
    RUN p-query-int ("memberId", OUTPUT iMid, OUTPUT cMode).
    IF cMode = "bad" THEN DO:
        RUN p-reply-named ("credits", NEW JsonArray()).
        RETURN.
    END.
    cStatus = fQuery("status").
    IF cStatus = ? THEN cStatus = "".
    ja = NEW JsonArray().
    FOR EACH bC NO-LOCK BY bC.CreditId:
        IF cMode = "ok" AND bC.MemberId <> iMid THEN NEXT.
        IF cStatus <> "" AND NOT fEq(bC.CreditStatus, cStatus) THEN NEXT.
        ja:Add(fCreditJson(bC.CreditId)).
    END.
    RUN p-reply-named ("credits", ja).
END PROCEDURE.

PROCEDURE h-coop-credit:
    DEFINE INPUT PARAMETER piId AS INTEGER NO-UNDO.
    IF piId = ? THEN RUN p-not-found (?, "CREDIT_NOT_FOUND", "credit order").
    ELSE RUN p-reply-one (fCreditJson(piId), piId, "CREDIT_NOT_FOUND", "credit order").
END PROCEDURE.

PROCEDURE h-coop-lots:
    DEFINE VARIABLE ja AS JsonArray NO-UNDO.
    DEFINE BUFFER bL FOR HarvestLot.
    ja = NEW JsonArray().
    FOR EACH bL NO-LOCK BY bL.LotId:
        ja:Add(fLotJson(bL.LotId)).
    END.
    RUN p-reply-named ("lots", ja).
END PROCEDURE.

PROCEDURE h-coop-lot:
    DEFINE INPUT PARAMETER piId AS INTEGER NO-UNDO.
    RUN p-reply-one (fLotJson(piId), piId, "LOT_NOT_FOUND", "harvest lot").
END PROCEDURE.

PROCEDURE h-coop-contracts:
    DEFINE VARIABLE ja AS JsonArray NO-UNDO.
    DEFINE BUFFER bC FOR BuyerContract.
    ja = NEW JsonArray().
    FOR EACH bC NO-LOCK BY bC.ContractId:
        ja:Add(fContractJson(bC.ContractId)).
    END.
    RUN p-reply-named ("contracts", ja).
END PROCEDURE.

PROCEDURE h-coop-contract:
    DEFINE INPUT PARAMETER piId AS INTEGER NO-UNDO.
    RUN p-reply-one (fContractJson(piId), piId, "CONTRACT_NOT_FOUND", "contract").
END PROCEDURE.

PROCEDURE h-coop-allocations:
    DEFINE VARIABLE ja      AS JsonArray NO-UNDO.
    DEFINE VARIABLE iLot    AS INTEGER   NO-UNDO.
    DEFINE VARIABLE iCon    AS INTEGER   NO-UNDO.
    DEFINE VARIABLE cLot    AS CHARACTER NO-UNDO.
    DEFINE VARIABLE cCon    AS CHARACTER NO-UNDO.
    DEFINE VARIABLE cStatus AS CHARACTER NO-UNDO.
    DEFINE BUFFER bA FOR Allocation.
    RUN p-query-int ("lotId", OUTPUT iLot, OUTPUT cLot).
    RUN p-query-int ("contractId", OUTPUT iCon, OUTPUT cCon).
    IF cLot = "bad" OR cCon = "bad" THEN DO:
        RUN p-reply-named ("allocations", NEW JsonArray()).
        RETURN.
    END.
    cStatus = fQuery("status").
    IF cStatus = ? THEN cStatus = "".
    ja = NEW JsonArray().
    FOR EACH bA NO-LOCK BY bA.AllocationId:
        IF cLot = "ok" AND bA.LotId <> iLot THEN NEXT.
        IF cCon = "ok" AND bA.ContractId <> iCon THEN NEXT.
        IF cStatus <> "" AND NOT fEq(bA.AllocStatus, cStatus) THEN NEXT.
        ja:Add(fAllocJson(bA.AllocationId)).
    END.
    RUN p-reply-named ("allocations", ja).
END PROCEDURE.

PROCEDURE h-coop-allocation:
    DEFINE INPUT PARAMETER piId AS INTEGER NO-UNDO.
    RUN p-reply-one (fAllocJson(piId), piId, "ALLOCATION_NOT_FOUND", "allocation").
END PROCEDURE.

PROCEDURE h-coop-payouts:
    DEFINE VARIABLE ja      AS JsonArray NO-UNDO.
    DEFINE VARIABLE iLot    AS INTEGER   NO-UNDO.
    DEFINE VARIABLE iMem    AS INTEGER   NO-UNDO.
    DEFINE VARIABLE cLot    AS CHARACTER NO-UNDO.
    DEFINE VARIABLE cMem    AS CHARACTER NO-UNDO.
    DEFINE VARIABLE cStatus AS CHARACTER NO-UNDO.
    DEFINE BUFFER bP FOR Payout.
    RUN p-query-int ("lotId", OUTPUT iLot, OUTPUT cLot).
    RUN p-query-int ("memberId", OUTPUT iMem, OUTPUT cMem).
    IF cLot = "bad" OR cMem = "bad" THEN DO:
        RUN p-reply-named ("payouts", NEW JsonArray()).
        RETURN.
    END.
    cStatus = fQuery("status").
    IF cStatus = ? THEN cStatus = "".
    ja = NEW JsonArray().
    FOR EACH bP NO-LOCK BY bP.PayoutId:
        IF cLot = "ok" AND bP.LotId <> iLot THEN NEXT.
        IF cMem = "ok" AND bP.MemberId <> iMem THEN NEXT.
        IF cStatus <> "" AND NOT fEq(bP.PayoutStatus, cStatus) THEN NEXT.
        ja:Add(fPayoutJson(bP.PayoutId)).
    END.
    RUN p-reply-named ("payouts", ja).
END PROCEDURE.

PROCEDURE h-coop-payout:
    DEFINE INPUT PARAMETER piId AS INTEGER NO-UNDO.
    RUN p-reply-one (fPayoutJson(piId), piId, "PAYOUT_NOT_FOUND", "payout").
END PROCEDURE.

/* ---------- credit orders ---------- */
PROCEDURE h-coop-credit-create:
    DEFINE VARIABLE iMember AS INTEGER NO-UNDO.
    DEFINE VARIABLE iAmt    AS INT64   NO-UNDO.
    DEFINE VARIABLE lSet    AS LOGICAL NO-UNDO.
    DEFINE VARIABLE lOk     AS LOGICAL NO-UNDO.
    DEFINE VARIABLE cItem   AS CHARACTER NO-UNDO.
    DEFINE VARIABLE tAsOf   AS DATETIME-TZ NO-UNDO.
    DEFINE VARIABLE cReq    AS CHARACTER NO-UNDO.
    DEFINE VARIABLE cActor  AS CHARACTER NO-UNDO.
    DEFINE VARIABLE joV     AS JsonObject NO-UNDO.
    DEFINE VARIABLE jo      AS JsonObject NO-UNDO.
    DEFINE VARIABLE joFacts AS JsonObject NO-UNDO.
    DEFINE VARIABLE cVerdict AS CHARACTER NO-UNDO.
    DEFINE VARIABLE cReasons AS CHARACTER NO-UNDO.
    DEFINE VARIABLE lPass   AS LOGICAL NO-UNDO.
    DEFINE VARIABLE iNew    AS INTEGER NO-UNDO.
    DEFINE VARIABLE iAud    AS INTEGER NO-UNDO.
    DEFINE BUFFER bMem FOR CoopMember.
    DEFINE BUFFER bCr  FOR InputCredit.
    RUN p-read-posint ("memberId", "memberId must be an integer.", 2147483647, OUTPUT iMember, OUTPUT lOk).
    IF NOT lOk THEN RETURN.
    RUN p-read-money ("amount", "amount must be a positive number in Rand with at most 2 decimals (up to {&MAX_AMOUNT_RAND}).", "required-positive", OUTPUT iAmt, OUTPUT lSet, OUTPUT lOk).
    IF NOT lOk THEN RETURN.
    cItem = "".
    IF goBody:Has("item") THEN DO:
        RUN get-str (goBody, "item", OUTPUT cItem, OUTPUT lOk).
        IF NOT lOk THEN DO:
            RUN reply-error (400, "VALIDATION_ERROR", "item must be a string.", "item").
            RETURN.
        END.
    END.
    cItem = SUBSTRING(cItem, 1, 80).
    RUN p-coop-common (OUTPUT tAsOf, OUTPUT cReq, OUTPUT cActor, OUTPUT lOk).
    IF NOT lOk THEN RETURN.
    FIND bMem WHERE bMem.MemberId = iMember NO-LOCK NO-ERROR.
    IF NOT AVAILABLE bMem THEN DO:
        RUN p-not-found (iMember, "MEMBER_NOT_FOUND", "member").
        RETURN.
    END.
    RUN p-check-credit (iMember, iAmt, 0, OUTPUT joV).
    cVerdict = joV:GetCharacter("verdict").
    lPass = fEq(cVerdict, "approved_by_rules").
    RUN p-reasons-text (joV, OUTPUT cReasons).
    RUN p-facts-copy (joV, OUTPUT joFacts).
    CREATE bCr.
    ASSIGN bCr.CreditId      = NEXT-VALUE(CreditSeq)
           bCr.MemberId      = iMember
           bCr.ItemName      = cItem
           bCr.Amount        = fCentsToDec(iAmt)
           bCr.RepaidAmount  = 0
           bCr.CreditStatus  = (IF lPass THEN "pending_approval" ELSE "rejected")
           bCr.Verdict       = cVerdict
           bCr.RejectReasons = cReasons
           bCr.CreatedAt     = tAsOf
           bCr.RequestId     = cReq.
    iNew = bCr.CreditId.
    RELEASE bCr.
    RUN audit (cReq, "abl-rules", "credit_rule_check",
        "credit " + fPlain(iNew) + " member " + fPlain(iMember) + " " + fRand(iAmt) + " => " + cVerdict,
        tAsOf, OUTPUT iAud).
    jo = fCreditJson(iNew).
    jo:Add("facts", joFacts).
    RUN reply (201, jo).
END PROCEDURE.

PROCEDURE h-coop-credit-decide:
    DEFINE INPUT PARAMETER piId AS INTEGER NO-UNDO.
    DEFINE VARIABLE cDec    AS CHARACTER NO-UNDO.
    DEFINE VARIABLE lOk     AS LOGICAL   NO-UNDO.
    DEFINE VARIABLE tAsOf   AS DATETIME-TZ NO-UNDO.
    DEFINE VARIABLE cReq    AS CHARACTER NO-UNDO.
    DEFINE VARIABLE cActor  AS CHARACTER NO-UNDO.
    DEFINE VARIABLE cStatus AS CHARACTER NO-UNDO.
    DEFINE VARIABLE iMember AS INTEGER NO-UNDO.
    DEFINE VARIABLE iAmt    AS INT64   NO-UNDO.
    DEFINE VARIABLE joV     AS JsonObject NO-UNDO.
    DEFINE VARIABLE jo      AS JsonObject NO-UNDO.
    DEFINE VARIABLE cReasons AS CHARACTER NO-UNDO.
    DEFINE VARIABLE cEvent  AS CHARACTER NO-UNDO.
    DEFINE VARIABLE iAud    AS INTEGER NO-UNDO.
    DEFINE BUFFER bCr FOR InputCredit.
    RUN get-str (goBody, "decision", OUTPUT cDec, OUTPUT lOk).
    IF NOT lOk OR NOT (fEq(cDec, "approve") OR fEq(cDec, "reject")) THEN DO:
        RUN reply-error (400, "VALIDATION_ERROR", "decision must be approve or reject.", "decision").
        RETURN.
    END.
    RUN p-coop-common (OUTPUT tAsOf, OUTPUT cReq, OUTPUT cActor, OUTPUT lOk).
    IF NOT lOk THEN RETURN.
    IF piId = ? THEN DO:
        RUN p-not-found (?, "CREDIT_NOT_FOUND", "credit order").
        RETURN.
    END.
    FIND bCr WHERE bCr.CreditId = piId NO-LOCK NO-ERROR.
    IF NOT AVAILABLE bCr THEN DO:
        RUN p-not-found (piId, "CREDIT_NOT_FOUND", "credit order").
        RETURN.
    END.
    ASSIGN cStatus = bCr.CreditStatus iMember = bCr.MemberId iAmt = fToCents(bCr.Amount).
    IF fEq(cDec, "approve") THEN DO:
        IF fEq(cStatus, "rejected") THEN DO:
            RUN reply-error (409, "NOT_APPROVABLE", "This credit order was rejected by the rules and cannot be approved.", ?).
            RETURN.
        END.
        IF NOT fEq(cStatus, "pending_approval") THEN DO:
            RUN reply-error (409, "ALREADY_DECIDED", "Credit order is already " + cStatus + ".", ?).
            RETURN.
        END.
        RUN p-check-credit (iMember, iAmt, piId, OUTPUT joV).
        FIND bCr WHERE bCr.CreditId = piId EXCLUSIVE-LOCK NO-WAIT NO-ERROR.
        IF LOCKED bCr THEN DO:
            RUN reply-error (409, "RECORD_LOCKED", "The record is being changed by someone else. Try again.", ?).
            RETURN.
        END.
        IF NOT AVAILABLE bCr THEN DO:
            RUN p-not-found (piId, "CREDIT_NOT_FOUND", "credit order").
            RETURN.
        END.
        IF NOT fEq(joV:GetCharacter("verdict"), "approved_by_rules") THEN DO:
            RUN p-reasons-text (joV, OUTPUT cReasons).
            ASSIGN bCr.CreditStatus  = "rejected"
                   bCr.Verdict       = joV:GetCharacter("verdict")
                   bCr.RejectReasons = cReasons
                   bCr.DecidedAt     = tAsOf.
            RELEASE bCr.
            RUN audit (cReq, cActor, "credit_approve_blocked_by_rules", "credit " + fPlain(piId), tAsOf, OUTPUT iAud).
            jo = fCreditJson(piId).
            jo:Add("error", "NOT_APPROVABLE").
            RUN reply (409, jo).
            RETURN.
        END.
        ASSIGN bCr.CreditStatus = "approved" bCr.DecidedAt = tAsOf.
        cEvent = "credit_approved".
    END.
    ELSE DO:
        IF NOT fEq(cStatus, "pending_approval") THEN DO:
            RUN reply-error (409, "ALREADY_DECIDED", "Credit order is already " + cStatus + ".", ?).
            RETURN.
        END.
        FIND bCr WHERE bCr.CreditId = piId EXCLUSIVE-LOCK NO-WAIT NO-ERROR.
        IF LOCKED bCr THEN DO:
            RUN reply-error (409, "RECORD_LOCKED", "The record is being changed by someone else. Try again.", ?).
            RETURN.
        END.
        IF NOT AVAILABLE bCr THEN DO:
            RUN p-not-found (piId, "CREDIT_NOT_FOUND", "credit order").
            RETURN.
        END.
        ASSIGN bCr.CreditStatus = "declined" bCr.DecidedAt = tAsOf.
        cEvent = "credit_declined".
    END.
    RELEASE bCr.
    RUN audit (cReq, cActor, cEvent, "credit " + fPlain(piId), tAsOf, OUTPUT iAud).
    RUN reply (200, fCreditJson(piId)).
END PROCEDURE.

/* ---------- allocations ---------- */
PROCEDURE p-insert-alloc:
    DEFINE INPUT  PARAMETER piLot   AS INTEGER     NO-UNDO.
    DEFINE INPUT  PARAMETER piCon   AS INTEGER     NO-UNDO.
    DEFINE INPUT  PARAMETER piKg    AS INTEGER     NO-UNDO.
    DEFINE INPUT  PARAMETER tAsOf   AS DATETIME-TZ NO-UNDO.
    DEFINE INPUT  PARAMETER pcReq   AS CHARACTER   NO-UNDO.
    DEFINE OUTPUT PARAMETER piNew   AS INTEGER     NO-UNDO.
    DEFINE BUFFER bC FOR BuyerContract.
    DEFINE BUFFER bA FOR Allocation.
    DEFINE VARIABLE joV      AS JsonObject NO-UNDO.
    DEFINE VARIABLE cVerdict AS CHARACTER  NO-UNDO.
    DEFINE VARIABLE cReasons AS CHARACTER  NO-UNDO.
    DEFINE VARIABLE lPass    AS LOGICAL    NO-UNDO.
    DEFINE VARIABLE iAud     AS INTEGER    NO-UNDO.
    DEFINE VARIABLE dPrice   AS DECIMAL    NO-UNDO.
    FIND bC WHERE bC.ContractId = piCon NO-LOCK.
    dPrice = bC.PricePerKg.
    RUN p-check-alloc (piLot, piCon, piKg, 0, OUTPUT joV).
    cVerdict = joV:GetCharacter("verdict").
    lPass = fEq(cVerdict, "approved_by_rules").
    RUN p-reasons-text (joV, OUTPUT cReasons).
    CREATE bA.
    ASSIGN bA.AllocationId  = NEXT-VALUE(AllocationSeq)
           bA.LotId         = piLot
           bA.ContractId    = piCon
           bA.Kg            = piKg
           bA.PricePerKg    = dPrice
           bA.AllocStatus   = (IF lPass THEN "pending_approval" ELSE "rejected")
           bA.Verdict       = cVerdict
           bA.RejectReasons = cReasons
           bA.CreatedAt     = tAsOf
           bA.RequestId     = pcReq.
    piNew = bA.AllocationId.
    RELEASE bA.
    RUN audit (pcReq, "abl-rules", "allocation_rule_check",
        "allocation " + fPlain(piNew) + " lot " + fPlain(piLot) + " contract " + fPlain(piCon)
        + " " + fPlain(piKg) + " kg => " + cVerdict,
        tAsOf, OUTPUT iAud).
END PROCEDURE.

PROCEDURE h-coop-alloc-create:
    DEFINE VARIABLE iLot AS INTEGER NO-UNDO.
    DEFINE VARIABLE iCon AS INTEGER NO-UNDO.
    DEFINE VARIABLE iKg  AS INTEGER NO-UNDO.
    DEFINE VARIABLE lOk  AS LOGICAL NO-UNDO.
    DEFINE VARIABLE tAsOf AS DATETIME-TZ NO-UNDO.
    DEFINE VARIABLE cReq  AS CHARACTER NO-UNDO.
    DEFINE VARIABLE cActor AS CHARACTER NO-UNDO.
    DEFINE VARIABLE iNew  AS INTEGER NO-UNDO.
    DEFINE VARIABLE jo    AS JsonObject NO-UNDO.
    DEFINE VARIABLE joV   AS JsonObject NO-UNDO.
    DEFINE VARIABLE joFacts AS JsonObject NO-UNDO.
    DEFINE BUFFER bL FOR HarvestLot.
    DEFINE BUFFER bC FOR BuyerContract.
    RUN p-read-posint ("lotId", "lotId must be an integer.", 2147483647, OUTPUT iLot, OUTPUT lOk).
    IF NOT lOk THEN RETURN.
    RUN p-read-posint ("contractId", "contractId must be an integer.", 2147483647, OUTPUT iCon, OUTPUT lOk).
    IF NOT lOk THEN RETURN.
    RUN p-read-posint ("kg", "kg must be a whole number between 1 and {&MAX_KG}.", {&MAX_KG}, OUTPUT iKg, OUTPUT lOk).
    IF NOT lOk THEN RETURN.
    RUN p-coop-common (OUTPUT tAsOf, OUTPUT cReq, OUTPUT cActor, OUTPUT lOk).
    IF NOT lOk THEN RETURN.
    FIND bL WHERE bL.LotId = iLot NO-LOCK NO-ERROR.
    IF NOT AVAILABLE bL THEN DO:
        RUN p-not-found (iLot, "LOT_NOT_FOUND", "harvest lot").
        RETURN.
    END.
    FIND bC WHERE bC.ContractId = iCon NO-LOCK NO-ERROR.
    IF NOT AVAILABLE bC THEN DO:
        RUN p-not-found (iCon, "CONTRACT_NOT_FOUND", "contract").
        RETURN.
    END.
    /* Rule result is recomputed inside p-insert-alloc; facts come from a twin check that does not insert. */
    RUN p-check-alloc (iLot, iCon, iKg, 0, OUTPUT joV).
    RUN p-facts-copy (joV, OUTPUT joFacts).
    RUN p-insert-alloc (iLot, iCon, iKg, tAsOf, cReq, OUTPUT iNew).
    jo = fAllocJson(iNew).
    jo:Add("facts", joFacts).
    RUN reply (201, jo).
END PROCEDURE.

PROCEDURE h-coop-alloc-decide:
    DEFINE INPUT PARAMETER piId AS INTEGER NO-UNDO.
    DEFINE VARIABLE cDec    AS CHARACTER NO-UNDO.
    DEFINE VARIABLE lOk     AS LOGICAL   NO-UNDO.
    DEFINE VARIABLE tAsOf   AS DATETIME-TZ NO-UNDO.
    DEFINE VARIABLE cReq    AS CHARACTER NO-UNDO.
    DEFINE VARIABLE cActor  AS CHARACTER NO-UNDO.
    DEFINE VARIABLE cStatus AS CHARACTER NO-UNDO.
    DEFINE VARIABLE iLot    AS INTEGER NO-UNDO.
    DEFINE VARIABLE iCon    AS INTEGER NO-UNDO.
    DEFINE VARIABLE iKg     AS INTEGER NO-UNDO.
    DEFINE VARIABLE joV     AS JsonObject NO-UNDO.
    DEFINE VARIABLE jo      AS JsonObject NO-UNDO.
    DEFINE VARIABLE cReasons AS CHARACTER NO-UNDO.
    DEFINE VARIABLE cEvent  AS CHARACTER NO-UNDO.
    DEFINE VARIABLE iAud    AS INTEGER NO-UNDO.
    DEFINE BUFFER bA FOR Allocation.
    RUN get-str (goBody, "decision", OUTPUT cDec, OUTPUT lOk).
    IF NOT lOk OR NOT (fEq(cDec, "approve") OR fEq(cDec, "reject") OR fEq(cDec, "deliver")) THEN DO:
        RUN reply-error (400, "VALIDATION_ERROR", "decision must be approve, reject or deliver.", "decision").
        RETURN.
    END.
    RUN p-coop-common (OUTPUT tAsOf, OUTPUT cReq, OUTPUT cActor, OUTPUT lOk).
    IF NOT lOk THEN RETURN.
    IF piId = ? THEN DO:
        RUN p-not-found (?, "ALLOCATION_NOT_FOUND", "allocation").
        RETURN.
    END.
    FIND bA WHERE bA.AllocationId = piId NO-LOCK NO-ERROR.
    IF NOT AVAILABLE bA THEN DO:
        RUN p-not-found (piId, "ALLOCATION_NOT_FOUND", "allocation").
        RETURN.
    END.
    ASSIGN cStatus = bA.AllocStatus iLot = bA.LotId iCon = bA.ContractId iKg = bA.Kg.
    IF fEq(cDec, "approve") THEN DO:
        IF fEq(cStatus, "rejected") THEN DO:
            RUN reply-error (409, "NOT_APPROVABLE", "This allocation was rejected by the rules and cannot be approved.", ?).
            RETURN.
        END.
        IF NOT fEq(cStatus, "pending_approval") THEN DO:
            RUN reply-error (409, "ALREADY_DECIDED", "Allocation is already " + cStatus + ".", ?).
            RETURN.
        END.
        RUN p-check-alloc (iLot, iCon, iKg, piId, OUTPUT joV).
        FIND bA WHERE bA.AllocationId = piId EXCLUSIVE-LOCK NO-WAIT NO-ERROR.
        IF LOCKED bA THEN DO:
            RUN reply-error (409, "RECORD_LOCKED", "The record is being changed by someone else. Try again.", ?).
            RETURN.
        END.
        IF NOT AVAILABLE bA THEN DO:
            RUN p-not-found (piId, "ALLOCATION_NOT_FOUND", "allocation").
            RETURN.
        END.
        IF NOT fEq(joV:GetCharacter("verdict"), "approved_by_rules") THEN DO:
            RUN p-reasons-text (joV, OUTPUT cReasons).
            ASSIGN bA.AllocStatus   = "rejected"
                   bA.Verdict       = joV:GetCharacter("verdict")
                   bA.RejectReasons = cReasons
                   bA.DecidedAt     = tAsOf.
            RELEASE bA.
            RUN audit (cReq, cActor, "allocation_approve_blocked_by_rules", "allocation " + fPlain(piId), tAsOf, OUTPUT iAud).
            jo = fAllocJson(piId).
            jo:Add("error", "NOT_APPROVABLE").
            RUN reply (409, jo).
            RETURN.
        END.
        ASSIGN bA.AllocStatus = "approved" bA.DecidedAt = tAsOf.
        cEvent = "allocation_approved".
    END.
    ELSE IF fEq(cDec, "reject") THEN DO:
        IF NOT fEq(cStatus, "pending_approval") THEN DO:
            RUN reply-error (409, "ALREADY_DECIDED", "Allocation is already " + cStatus + ".", ?).
            RETURN.
        END.
        FIND bA WHERE bA.AllocationId = piId EXCLUSIVE-LOCK NO-WAIT NO-ERROR.
        IF LOCKED bA THEN DO:
            RUN reply-error (409, "RECORD_LOCKED", "The record is being changed by someone else. Try again.", ?).
            RETURN.
        END.
        IF NOT AVAILABLE bA THEN DO:
            RUN p-not-found (piId, "ALLOCATION_NOT_FOUND", "allocation").
            RETURN.
        END.
        ASSIGN bA.AllocStatus = "declined" bA.DecidedAt = tAsOf.
        cEvent = "allocation_declined".
    END.
    ELSE DO:
        IF fEq(cStatus, "delivered") THEN DO:
            RUN reply-error (409, "ALREADY_DECIDED", "Allocation is already delivered.", ?).
            RETURN.
        END.
        IF NOT fEq(cStatus, "approved") THEN DO:
            RUN reply-error (409, "NOT_DELIVERABLE", "Only an approved allocation can be marked delivered (this one is " + cStatus + ").", ?).
            RETURN.
        END.
        FIND bA WHERE bA.AllocationId = piId EXCLUSIVE-LOCK NO-WAIT NO-ERROR.
        IF LOCKED bA THEN DO:
            RUN reply-error (409, "RECORD_LOCKED", "The record is being changed by someone else. Try again.", ?).
            RETURN.
        END.
        IF NOT AVAILABLE bA THEN DO:
            RUN p-not-found (piId, "ALLOCATION_NOT_FOUND", "allocation").
            RETURN.
        END.
        ASSIGN bA.AllocStatus = "delivered" bA.DeliveredAt = tAsOf.
        cEvent = "allocation_delivered".
    END.
    RELEASE bA.
    RUN audit (cReq, cActor, cEvent, "allocation " + fPlain(piId), tAsOf, OUTPUT iAud).
    RUN reply (200, fAllocJson(piId)).
END PROCEDURE.

PROCEDURE h-coop-fair:
    DEFINE INPUT PARAMETER piLot AS INTEGER NO-UNDO.
    DEFINE VARIABLE lCommit AS LOGICAL NO-UNDO INITIAL FALSE.
    DEFINE VARIABLE lOk     AS LOGICAL NO-UNDO.
    DEFINE VARIABLE tAsOf   AS DATETIME-TZ NO-UNDO.
    DEFINE VARIABLE cReq    AS CHARACTER NO-UNDO.
    DEFINE VARIABLE cActor  AS CHARACTER NO-UNDO.
    DEFINE VARIABLE poPlan  AS JsonObject NO-UNDO.
    DEFINE VARIABLE ja      AS JsonArray NO-UNDO.
    DEFINE VARIABLE iNew    AS INTEGER NO-UNDO.
    DEFINE VARIABLE iAud    AS INTEGER NO-UNDO.
    DEFINE VARIABLE iCount  AS INTEGER NO-UNDO.
    DEFINE VARIABLE iPlanned AS INTEGER NO-UNDO.
    DEFINE BUFFER bL FOR HarvestLot.
    IF goBody:Has("commit") THEN DO:
        IF goBody:GetType("commit") <> JsonDataType:BOOLEAN THEN DO:
            RUN reply-error (400, "VALIDATION_ERROR", "commit must be true or false.", "commit").
            RETURN.
        END.
        lCommit = goBody:GetLogical("commit").
    END.
    RUN p-coop-common (OUTPUT tAsOf, OUTPUT cReq, OUTPUT cActor, OUTPUT lOk).
    IF NOT lOk THEN RETURN.
    IF piLot = ? THEN DO:
        RUN p-not-found (?, "LOT_NOT_FOUND", "harvest lot").
        RETURN.
    END.
    FIND bL WHERE bL.LotId = piLot NO-LOCK NO-ERROR.
    IF NOT AVAILABLE bL THEN DO:
        RUN p-not-found (piLot, "LOT_NOT_FOUND", "harvest lot").
        RETURN.
    END.
    RUN p-fair-plan (piLot, OUTPUT poPlan).
    IF NOT lCommit THEN DO:
        poPlan:Add("committed", FALSE).
        RUN reply (200, poPlan).
        RETURN.
    END.
    ja = NEW JsonArray().
    iCount = 0.
    FOR EACH ttFair BY ttFair.contractId:
        IF ttFair.allocKg <= 0 THEN NEXT.
        RUN p-insert-alloc (piLot, ttFair.contractId, ttFair.allocKg, tAsOf, cReq, OUTPUT iNew).
        ja:Add(fAllocJson(iNew)).
        iCount = iCount + 1.
    END.
    iPlanned = poPlan:GetInteger("availableKg") - poPlan:GetInteger("unallocatedKg").
    RUN audit (cReq, cActor, "fair_allocation_committed",
        "lot " + fPlain(piLot) + ": " + fPlain(iCount) + " allocation(s), " + fPlain(iPlanned)
        + " kg, method " + poPlan:GetCharacter("method"),
        tAsOf, OUTPUT iAud).
    poPlan:Add("committed", TRUE).
    poPlan:Add("created", ja).
    RUN reply (201, poPlan).
END PROCEDURE.

/* ---------- payouts ---------- */
PROCEDURE h-coop-payout-create:
    DEFINE VARIABLE iLot   AS INTEGER NO-UNDO.
    DEFINE VARIABLE iMem   AS INTEGER NO-UNDO.
    DEFINE VARIABLE iGross AS INT64   NO-UNDO.
    DEFINE VARIABLE iDed   AS INT64   NO-UNDO.
    DEFINE VARIABLE lGross AS LOGICAL NO-UNDO.
    DEFINE VARIABLE lDed   AS LOGICAL NO-UNDO.
    DEFINE VARIABLE lOk    AS LOGICAL NO-UNDO.
    DEFINE VARIABLE tAsOf  AS DATETIME-TZ NO-UNDO.
    DEFINE VARIABLE cReq   AS CHARACTER NO-UNDO.
    DEFINE VARIABLE cActor AS CHARACTER NO-UNDO.
    DEFINE VARIABLE iShare AS INT64 NO-UNDO.
    DEFINE VARIABLE iCommitted AS INT64 NO-UNDO.
    DEFINE VARIABLE iRemain AS INT64 NO-UNDO.
    DEFINE VARIABLE iOpen  AS INT64 NO-UNDO.
    DEFINE VARIABLE joV    AS JsonObject NO-UNDO.
    DEFINE VARIABLE jo     AS JsonObject NO-UNDO.
    DEFINE VARIABLE joFacts AS JsonObject NO-UNDO.
    DEFINE VARIABLE cVerdict AS CHARACTER NO-UNDO.
    DEFINE VARIABLE cReasons AS CHARACTER NO-UNDO.
    DEFINE VARIABLE lPass  AS LOGICAL NO-UNDO.
    DEFINE VARIABLE iNew   AS INTEGER NO-UNDO.
    DEFINE VARIABLE iAud   AS INTEGER NO-UNDO.
    DEFINE BUFFER bL FOR HarvestLot.
    DEFINE BUFFER bM FOR CoopMember.
    DEFINE BUFFER bP FOR Payout.
    RUN p-read-posint ("lotId", "lotId must be an integer.", 2147483647, OUTPUT iLot, OUTPUT lOk).
    IF NOT lOk THEN RETURN.
    RUN p-read-posint ("memberId", "memberId must be an integer.", 2147483647, OUTPUT iMem, OUTPUT lOk).
    IF NOT lOk THEN RETURN.
    RUN p-read-money ("grossAmount", "grossAmount must be a positive number in Rand with at most 2 decimals.", "optional-positive", OUTPUT iGross, OUTPUT lGross, OUTPUT lOk).
    IF NOT lOk THEN RETURN.
    RUN p-read-money ("creditDeducted", "creditDeducted must be zero or a positive number in Rand with at most 2 decimals.", "optional-nonneg", OUTPUT iDed, OUTPUT lDed, OUTPUT lOk).
    IF NOT lOk THEN RETURN.
    RUN p-coop-common (OUTPUT tAsOf, OUTPUT cReq, OUTPUT cActor, OUTPUT lOk).
    IF NOT lOk THEN RETURN.
    FIND bL WHERE bL.LotId = iLot NO-LOCK NO-ERROR.
    IF NOT AVAILABLE bL THEN DO:
        RUN p-not-found (iLot, "LOT_NOT_FOUND", "harvest lot").
        RETURN.
    END.
    FIND bM WHERE bM.MemberId = iMem NO-LOCK NO-ERROR.
    IF NOT AVAILABLE bM THEN DO:
        RUN p-not-found (iMem, "MEMBER_NOT_FOUND", "member").
        RETURN.
    END.
    RUN p-member-share-cents (iLot, iMem, OUTPUT iShare).
    RUN p-committed-gross (iLot, iMem, 0, OUTPUT iCommitted).
    iRemain = iShare - iCommitted.
    IF iRemain < 0 THEN iRemain = 0.
    IF NOT lGross THEN iGross = iRemain.
    RUN p-deductible (iMem, 0, OUTPUT iOpen).
    IF NOT lDed THEN DO:
        iDed = iOpen.
        IF iDed > iGross THEN iDed = iGross.
    END.
    RUN p-check-payout (iLot, iMem, iGross, iDed, 0, OUTPUT joV).
    cVerdict = joV:GetCharacter("verdict").
    lPass = fEq(cVerdict, "approved_by_rules").
    RUN p-reasons-text (joV, OUTPUT cReasons).
    RUN p-facts-copy (joV, OUTPUT joFacts).
    CREATE bP.
    ASSIGN bP.PayoutId       = NEXT-VALUE(PayoutSeq)
           bP.LotId          = iLot
           bP.MemberId       = iMem
           bP.GrossAmount    = fCentsToDec(iGross)
           bP.CreditDeducted = fCentsToDec(iDed)
           bP.NetAmount      = fCentsToDec(iGross - iDed)
           bP.PayoutStatus   = (IF lPass THEN "pending_approval" ELSE "rejected")
           bP.Verdict        = cVerdict
           bP.RejectReasons  = cReasons
           bP.CreatedAt      = tAsOf
           bP.RequestId      = cReq.
    iNew = bP.PayoutId.
    RELEASE bP.
    RUN audit (cReq, "abl-rules", "payout_rule_check",
        "payout " + fPlain(iNew) + " lot " + fPlain(iLot) + " member " + fPlain(iMem)
        + " gross " + fRand(iGross) + " credit " + fRand(iDed) + " net " + fRand(iGross - iDed)
        + " => " + cVerdict,
        tAsOf, OUTPUT iAud).
    jo = fPayoutJson(iNew).
    jo:Add("facts", joFacts).
    RUN reply (201, jo).
END PROCEDURE.

PROCEDURE h-coop-payout-decide:
    DEFINE INPUT PARAMETER piId AS INTEGER NO-UNDO.
    DEFINE VARIABLE cDec    AS CHARACTER NO-UNDO.
    DEFINE VARIABLE lOk     AS LOGICAL   NO-UNDO.
    DEFINE VARIABLE tAsOf   AS DATETIME-TZ NO-UNDO.
    DEFINE VARIABLE cReq    AS CHARACTER NO-UNDO.
    DEFINE VARIABLE cActor  AS CHARACTER NO-UNDO.
    DEFINE VARIABLE cStatus AS CHARACTER NO-UNDO.
    DEFINE VARIABLE iLot    AS INTEGER NO-UNDO.
    DEFINE VARIABLE iMem    AS INTEGER NO-UNDO.
    DEFINE VARIABLE iGross  AS INT64   NO-UNDO.
    DEFINE VARIABLE iDed    AS INT64   NO-UNDO.
    DEFINE VARIABLE joV     AS JsonObject NO-UNDO.
    DEFINE VARIABLE jo      AS JsonObject NO-UNDO.
    DEFINE VARIABLE cReasons AS CHARACTER NO-UNDO.
    DEFINE VARIABLE iAud    AS INTEGER NO-UNDO.
    DEFINE VARIABLE iLeft   AS INT64   NO-UNDO.
    DEFINE VARIABLE iRoom   AS INT64   NO-UNDO.
    DEFINE VARIABLE iTake   AS INT64   NO-UNDO.
    DEFINE BUFFER bP  FOR Payout.
    DEFINE BUFFER bCr FOR InputCredit.
    RUN get-str (goBody, "decision", OUTPUT cDec, OUTPUT lOk).
    IF NOT lOk OR NOT (fEq(cDec, "approve") OR fEq(cDec, "reject")) THEN DO:
        RUN reply-error (400, "VALIDATION_ERROR", "decision must be approve or reject.", "decision").
        RETURN.
    END.
    RUN p-coop-common (OUTPUT tAsOf, OUTPUT cReq, OUTPUT cActor, OUTPUT lOk).
    IF NOT lOk THEN RETURN.
    IF piId = ? THEN DO:
        RUN p-not-found (?, "PAYOUT_NOT_FOUND", "payout").
        RETURN.
    END.
    FIND bP WHERE bP.PayoutId = piId NO-LOCK NO-ERROR.
    IF NOT AVAILABLE bP THEN DO:
        RUN p-not-found (piId, "PAYOUT_NOT_FOUND", "payout").
        RETURN.
    END.
    ASSIGN cStatus = bP.PayoutStatus iLot = bP.LotId iMem = bP.MemberId
           iGross = fToCents(bP.GrossAmount) iDed = fToCents(bP.CreditDeducted).
    IF fEq(cDec, "approve") THEN DO:
        IF fEq(cStatus, "rejected") THEN DO:
            RUN reply-error (409, "NOT_APPROVABLE", "This payout was rejected by the rules and cannot be approved.", ?).
            RETURN.
        END.
        IF NOT fEq(cStatus, "pending_approval") THEN DO:
            RUN reply-error (409, "ALREADY_DECIDED", "Payout is already " + cStatus + ".", ?).
            RETURN.
        END.
        RUN p-check-payout (iLot, iMem, iGross, iDed, piId, OUTPUT joV).
        FIND bP WHERE bP.PayoutId = piId EXCLUSIVE-LOCK NO-WAIT NO-ERROR.
        IF LOCKED bP THEN DO:
            RUN reply-error (409, "RECORD_LOCKED", "The record is being changed by someone else. Try again.", ?).
            RETURN.
        END.
        IF NOT AVAILABLE bP THEN DO:
            RUN p-not-found (piId, "PAYOUT_NOT_FOUND", "payout").
            RETURN.
        END.
        IF NOT fEq(joV:GetCharacter("verdict"), "approved_by_rules") THEN DO:
            RUN p-reasons-text (joV, OUTPUT cReasons).
            ASSIGN bP.PayoutStatus  = "rejected"
                   bP.Verdict       = joV:GetCharacter("verdict")
                   bP.RejectReasons = cReasons
                   bP.DecidedAt     = tAsOf
                   bP.NetAmount     = fCentsToDec(iGross - iDed).
            RELEASE bP.
            RUN audit (cReq, cActor, "payout_approve_blocked_by_rules", "payout " + fPlain(piId), tAsOf, OUTPUT iAud).
            jo = fPayoutJson(piId).
            jo:Add("error", "NOT_APPROVABLE").
            RUN reply (409, jo).
            RETURN.
        END.
        ASSIGN bP.PayoutStatus = "approved"
               bP.DecidedAt    = tAsOf
               bP.NetAmount    = fCentsToDec(iGross - iDed).
        RELEASE bP.
        RUN audit (cReq, cActor, "payout_approved", "payout " + fPlain(piId), tAsOf, OUTPUT iAud).
        /* Repay approved credit, oldest credit first. */
        iLeft = iDed.
        FOR EACH bCr EXCLUSIVE-LOCK WHERE bCr.MemberId = iMem AND bCr.CreditStatus = "approved" BY bCr.CreditId:
            IF iLeft <= 0 THEN LEAVE.
            iRoom = fToCents(bCr.Amount) - fToCents(bCr.RepaidAmount).
            IF iRoom <= 0 THEN NEXT.
            iTake = iLeft.
            IF iTake > iRoom THEN iTake = iRoom.
            bCr.RepaidAmount = fCentsToDec(fToCents(bCr.RepaidAmount) + iTake).
            iLeft = iLeft - iTake.
            RUN audit (cReq, cActor, "credit_repaid_by_payout",
                "credit " + fPlain(bCr.CreditId) + " repaid " + fRand(iTake) + " by payout " + fPlain(piId),
                tAsOf, OUTPUT iAud).
        END.
        RUN reply (200, fPayoutJson(piId)).
        RETURN.
    END.
    IF NOT fEq(cStatus, "pending_approval") THEN DO:
        RUN reply-error (409, "ALREADY_DECIDED", "Payout is already " + cStatus + ".", ?).
        RETURN.
    END.
    FIND bP WHERE bP.PayoutId = piId EXCLUSIVE-LOCK NO-WAIT NO-ERROR.
    IF LOCKED bP THEN DO:
        RUN reply-error (409, "RECORD_LOCKED", "The record is being changed by someone else. Try again.", ?).
        RETURN.
    END.
    IF NOT AVAILABLE bP THEN DO:
        RUN p-not-found (piId, "PAYOUT_NOT_FOUND", "payout").
        RETURN.
    END.
    ASSIGN bP.PayoutStatus = "declined" bP.DecidedAt = tAsOf.
    RELEASE bP.
    RUN audit (cReq, cActor, "payout_declined", "payout " + fPlain(piId), tAsOf, OUTPUT iAud).
    RUN reply (200, fPayoutJson(piId)).
END PROCEDURE.
