/*------------------------------------------------------------------------
  market.i - community harvest-day market: rules and routes, compiled as part
  of farm-api.p (included after coop.i, whose helpers it reuses).

  Do not run this file on its own. It implements the same behaviour as
  mock-pasoe/market-rules.js and mock-pasoe/market-handler.js (docs/MARKET.md).

  RULES: EVENT_NOT_IN_FUTURE, NO_REFERENCE_PRICE, PRICE_NOT_BELOW_RETAIL,
         LOT_CROP_MISMATCH, LOT_STOCK_EXCEEDED (events);
         EVENT_NOT_OPEN, RESERVATIONS_CLOSED, RESERVE_CAP_EXCEEDED,
         RESERVE_STOCK_EXCEEDED (reservations).
  Money is integer cents inside the rules, DECIMAL(2) Rand in the database and
  JSON. Quantities are whole kg. Character compares that the rules depend on
  use fEq (case-sensitive), like the JavaScript twin.
------------------------------------------------------------------------*/

/* items of the event being checked (from the request body, or from MarketItem on approve) */
DEFINE TEMP-TABLE ttMkItem NO-UNDO
    FIELD mkSeq   AS INTEGER
    FIELD mkCrop  AS CHARACTER
    FIELD mkLabel AS CHARACTER
    FIELD mkQty   AS INTEGER
    FIELD mkCents AS INT64
    FIELD mkLot   AS INTEGER
    INDEX idxMk IS UNIQUE PRIMARY mkSeq.

/* lot kg already taken by earlier items of the same event */
DEFINE TEMP-TABLE ttLotUse NO-UNDO
    FIELD luLot AS INTEGER
    FIELD luKg  AS INTEGER
    INDEX idxLu IS UNIQUE PRIMARY luLot.

/* ---------- small helpers ---------- */
FUNCTION fMkActive RETURNS LOGICAL (INPUT pc AS CHARACTER):
    RETURN fEq(pc, "pending_approval") OR fEq(pc, "published").
END FUNCTION.

/* retail-buyer reference price in cents for a crop, or -1 when there is none (case-sensitive, like the JS twin) */
FUNCTION fMkRefCents RETURNS INT64 (INPUT pcCrop AS CHARACTER):
    DEFINE BUFFER bRP FOR RetailBuyerPrice.
    FIND FIRST bRP WHERE bRP.Crop = pcCrop NO-LOCK NO-ERROR.
    IF NOT AVAILABLE bRP OR NOT fEq(bRP.Crop, pcCrop) THEN RETURN -1.
    RETURN fToCents(bRP.PricePerKg).
END FUNCTION.

FUNCTION fMkReservedKg RETURNS INTEGER (INPUT piItem AS INTEGER):
    DEFINE BUFFER bR FOR MarketReservation.
    DEFINE VARIABLE iKg AS INTEGER NO-UNDO INITIAL 0.
    FOR EACH bR NO-LOCK WHERE bR.ItemId = piItem:
        IF fEq(bR.ResStatus, "confirmed") THEN iKg = iKg + bR.QuantityKg.
    END.
    RETURN iKg.
END FUNCTION.

FUNCTION fMkReservableKg RETURNS INTEGER (INPUT piItem AS INTEGER, INPUT piQty AS INTEGER):
    DEFINE VARIABLE iLim AS INTEGER NO-UNDO.
    iLim = TRUNCATE(piQty * {&RESERVE_SHARE_PCT} / 100, 0).
    RETURN MAXIMUM(0, iLim - fMkReservedKg(piItem)).
END FUNCTION.

/* kg of a lot listed on active market events other than piExclEvent */
FUNCTION fMkLotListedKg RETURNS INTEGER (INPUT piLot AS INTEGER, INPUT piExclEvent AS INTEGER):
    DEFINE BUFFER bI FOR MarketItem.
    DEFINE BUFFER bE FOR MarketEvent.
    DEFINE VARIABLE iKg AS INTEGER NO-UNDO INITIAL 0.
    FOR EACH bI NO-LOCK WHERE bI.LotId = piLot:
        IF bI.EventId = piExclEvent THEN NEXT.
        FIND bE WHERE bE.EventId = bI.EventId NO-LOCK NO-ERROR.
        IF AVAILABLE bE AND fMkActive(bE.EventStatus) THEN iKg = iKg + bI.QuantityKg.
    END.
    RETURN iKg.
END FUNCTION.

PROCEDURE p-mk-reason:
    DEFINE INPUT PARAMETER poArr     AS JsonArray NO-UNDO.
    DEFINE INPUT PARAMETER pcCode    AS CHARACTER NO-UNDO.
    DEFINE INPUT PARAMETER pcMsg     AS CHARACTER NO-UNDO.
    DEFINE INPUT PARAMETER piItem    AS INTEGER   NO-UNDO.
    DEFINE INPUT PARAMETER pcSugName AS CHARACTER NO-UNDO.
    DEFINE INPUT PARAMETER pdSug     AS DECIMAL   NO-UNDO.
    DEFINE VARIABLE jo AS JsonObject NO-UNDO.
    jo = NEW JsonObject().
    jo:Add("code", pcCode).
    jo:Add("message", pcMsg).
    IF piItem > 0 THEN jo:Add("item", piItem).
    IF pcSugName <> "" THEN jo:Add(pcSugName, pdSug).
    poArr:Add(jo).
END PROCEDURE.

/* ---------- the event rules (items are in ttMkItem) ---------- */
PROCEDURE p-mk-check:
    DEFINE INPUT  PARAMETER ptStarts    AS DATETIME-TZ NO-UNDO.
    DEFINE INPUT  PARAMETER ptAsOf      AS DATETIME-TZ NO-UNDO.
    DEFINE INPUT  PARAMETER piExclEvent AS INTEGER     NO-UNDO.
    DEFINE OUTPUT PARAMETER poResult    AS JsonObject  NO-UNDO.
    DEFINE BUFFER bL FOR HarvestLot.
    DEFINE VARIABLE ja     AS JsonArray NO-UNDO.
    DEFINE VARIABLE iRef   AS INT64     NO-UNDO.
    DEFINE VARIABLE iAlloc AS INTEGER   NO-UNDO.
    DEFINE VARIABLE iAvail AS INTEGER   NO-UNDO.
    DEFINE VARIABLE iUsed  AS INTEGER   NO-UNDO.
    DEFINE VARIABLE cN     AS CHARACTER NO-UNDO.
    EMPTY TEMP-TABLE ttLotUse.
    ja = NEW JsonArray().
    IF ptStarts <= ptAsOf THEN
        RUN p-mk-reason (ja, "EVENT_NOT_IN_FUTURE", "The harvest day must start after now. Pick a later date.", 0, "", 0).
    FOR EACH ttMkItem BY ttMkItem.mkSeq:
        cN = fPlain(ttMkItem.mkSeq).
        iRef = fMkRefCents(ttMkItem.mkCrop).
        IF iRef < 0 THEN
            RUN p-mk-reason (ja, "NO_REFERENCE_PRICE",
                "Item " + cN + ": there is no retail-buyer reference price for " + ttMkItem.mkCrop + ", so the price cannot be checked.",
                ttMkItem.mkSeq, "", 0).
        ELSE IF ttMkItem.mkCents >= iRef THEN
            RUN p-mk-reason (ja, "PRICE_NOT_BELOW_RETAIL",
                "Item " + cN + ": " + fRand(ttMkItem.mkCents) + " per kg is not below the retail-buyer price of " + fRand(iRef)
                + " per kg for " + ttMkItem.mkCrop + ". Use " + fRand(iRef - 1) + " or less.",
                ttMkItem.mkSeq, "suggestedPricePerKg", fCentsToDec(iRef - 1)).
        IF ttMkItem.mkLot > 0 THEN DO:
            FIND bL WHERE bL.LotId = ttMkItem.mkLot NO-LOCK NO-ERROR.
            IF NOT fEq(bL.Crop, ttMkItem.mkCrop) THEN
                RUN p-mk-reason (ja, "LOT_CROP_MISMATCH",
                    "Item " + cN + ": harvest lot " + bL.LotCode + " is " + bL.Crop + ", not " + ttMkItem.mkCrop + ".",
                    ttMkItem.mkSeq, "", 0).
            ELSE DO:
                RUN p-lot-alloc-kg (bL.LotId, 0, OUTPUT iAlloc).
                FIND ttLotUse WHERE ttLotUse.luLot = bL.LotId NO-ERROR.
                iUsed = (IF AVAILABLE ttLotUse THEN ttLotUse.luKg ELSE 0).
                iAvail = MAXIMUM(0, bL.QuantityKg - iAlloc - fMkLotListedKg(bL.LotId, piExclEvent)).
                iAvail = MAXIMUM(0, iAvail - iUsed).
                IF ttMkItem.mkQty > iAvail THEN
                    RUN p-mk-reason (ja, "LOT_STOCK_EXCEEDED",
                        "Item " + cN + ": " + fPlain(ttMkItem.mkQty) + " kg is more than the " + fPlain(iAvail) + " kg of harvest lot "
                        + bL.LotCode + " that is not allocated or listed. Reduce to " + fPlain(iAvail) + " kg.",
                        ttMkItem.mkSeq, "suggestedKg", DECIMAL(iAvail)).
                IF NOT AVAILABLE ttLotUse THEN DO:
                    CREATE ttLotUse.
                    ttLotUse.luLot = bL.LotId.
                END.
                ttLotUse.luKg = ttLotUse.luKg + ttMkItem.mkQty.
            END.
        END.
    END.
    poResult = NEW JsonObject().
    poResult:Add("verdict", (IF ja:Length = 0 THEN "approved_by_rules" ELSE "rejected_by_rules")).
    poResult:Add("rejectReasons", ja).
END PROCEDURE.

/* ---------- the reservation rules ---------- */
PROCEDURE p-mk-check-res:
    DEFINE INPUT  PARAMETER piItem   AS INTEGER     NO-UNDO.
    DEFINE INPUT  PARAMETER piQty    AS INTEGER     NO-UNDO.
    DEFINE INPUT  PARAMETER ptAsOf   AS DATETIME-TZ NO-UNDO.
    DEFINE OUTPUT PARAMETER poResult AS JsonObject  NO-UNDO.
    DEFINE BUFFER bI FOR MarketItem.
    DEFINE BUFFER bE FOR MarketEvent.
    DEFINE VARIABLE ja    AS JsonArray NO-UNDO.
    DEFINE VARIABLE iLeft AS INTEGER   NO-UNDO.
    DEFINE VARIABLE iSug  AS INTEGER   NO-UNDO.
    FIND bI WHERE bI.ItemId = piItem NO-LOCK.
    FIND bE WHERE bE.EventId = bI.EventId NO-LOCK.
    ja = NEW JsonArray().
    IF NOT fEq(bE.EventStatus, "published") THEN
        RUN p-mk-reason (ja, "EVENT_NOT_OPEN", "This harvest day is " + bE.EventStatus + ", not published, so it cannot take reservations.", 0, "", 0).
    ELSE IF ptAsOf >= bE.StartsAt THEN
        RUN p-mk-reason (ja, "RESERVATIONS_CLOSED", "Reservations close when the harvest day starts. Walk up on the day instead.", 0, "", 0).
    iLeft = fMkReservableKg(bI.ItemId, bI.QuantityKg).
    IF piQty > {&RESERVE_CAP_KG} THEN DO:
        iSug = MINIMUM({&RESERVE_CAP_KG}, iLeft).
        RUN p-mk-reason (ja, "RESERVE_CAP_EXCEEDED", "One reservation can hold at most " + fPlain({&RESERVE_CAP_KG}) + " kg. Reduce to " + fPlain(iSug) + " kg.",
            0, "suggestedKg", DECIMAL(iSug)).
    END.
    ELSE IF piQty > iLeft THEN
        RUN p-mk-reason (ja, "RESERVE_STOCK_EXCEEDED", "Only " + fPlain(iLeft) + " kg of " + bI.ItemLabel + " can still be reserved. The rest is kept for walk-up buyers.",
            0, "suggestedKg", DECIMAL(iLeft)).
    poResult = NEW JsonObject().
    poResult:Add("verdict", (IF ja:Length = 0 THEN "approved_by_rules" ELSE "rejected_by_rules")).
    poResult:Add("rejectReasons", ja).
END PROCEDURE.

/* ---------- JSON builders ---------- */
FUNCTION fMkItemJson RETURNS JsonObject (INPUT piId AS INTEGER):
    DEFINE BUFFER bI FOR MarketItem.
    DEFINE VARIABLE jo   AS JsonObject NO-UNDO.
    DEFINE VARIABLE iRef AS INT64      NO-UNDO.
    DEFINE VARIABLE iRes AS INTEGER    NO-UNDO.
    FIND bI WHERE bI.ItemId = piId NO-LOCK NO-ERROR.
    IF NOT AVAILABLE bI THEN RETURN ?.
    iRef = fMkRefCents(bI.Crop).
    iRes = fMkReservedKg(bI.ItemId).
    jo = NEW JsonObject().
    jo:Add("itemId", bI.ItemId).
    jo:Add("crop", bI.Crop).
    jo:Add("label", bI.ItemLabel).
    jo:Add("quantityKg", bI.QuantityKg).
    jo:Add("pricePerKg", fCentsToDec(fToCents(bI.PricePerKg))).
    IF iRef < 0 THEN jo:AddNull("retailBuyerPricePerKg").
    ELSE jo:Add("retailBuyerPricePerKg", fCentsToDec(iRef)).
    IF bI.LotId > 0 THEN jo:Add("lotId", bI.LotId).
    ELSE jo:AddNull("lotId").
    jo:Add("reservedKg", iRes).
    jo:Add("reservableKg", fMkReservableKg(bI.ItemId, bI.QuantityKg)).
    jo:Add("walkUpKg", bI.QuantityKg - iRes).
    RETURN jo.
END FUNCTION.

FUNCTION fMkEventJson RETURNS JsonObject (INPUT piId AS INTEGER):
    DEFINE BUFFER bE FOR MarketEvent.
    DEFINE BUFFER bI FOR MarketItem.
    DEFINE VARIABLE jo    AS JsonObject NO-UNDO.
    DEFINE VARIABLE ja    AS JsonArray  NO-UNDO.
    DEFINE VARIABLE iTot  AS INTEGER    NO-UNDO INITIAL 0.
    DEFINE VARIABLE iRes  AS INTEGER    NO-UNDO INITIAL 0.
    FIND bE WHERE bE.EventId = piId NO-LOCK NO-ERROR.
    IF NOT AVAILABLE bE THEN RETURN ?.
    ja = NEW JsonArray().
    FOR EACH bI NO-LOCK WHERE bI.EventId = bE.EventId BY bI.ItemOrder BY bI.ItemId:
        ja:Add(fMkItemJson(bI.ItemId)).
        iTot = iTot + bI.QuantityKg.
        iRes = iRes + fMkReservedKg(bI.ItemId).
    END.
    jo = NEW JsonObject().
    jo:Add("eventId", bE.EventId).
    jo:Add("farmId", bE.FarmId).
    jo:Add("eventName", bE.EventName).
    jo:Add("venue", bE.VenueName).
    jo:Add("area", bE.VenueArea).
    jo:Add("notes", bE.EventNotes).
    RUN p-add-dt (jo, "startsAt", bE.StartsAt).
    RUN p-add-dt (jo, "endsAt", bE.EndsAt).
    jo:Add("status", bE.EventStatus).
    jo:Add("verdict", bE.Verdict).
    jo:Add("rejectReasons", fReasonsJson(bE.RejectReasons)).
    RUN p-add-dt (jo, "createdAt", bE.CreatedAt).
    RUN p-add-dt (jo, "decidedAt", bE.DecidedAt).
    jo:Add("requestId", bE.RequestId).
    jo:Add("items", ja).
    jo:Add("totalKg", iTot).
    jo:Add("reservedKg", iRes).
    RETURN jo.
END FUNCTION.

FUNCTION fMkResJson RETURNS JsonObject (INPUT piId AS INTEGER):
    DEFINE BUFFER bR FOR MarketReservation.
    DEFINE VARIABLE jo AS JsonObject NO-UNDO.
    FIND bR WHERE bR.ReservationId = piId NO-LOCK NO-ERROR.
    IF NOT AVAILABLE bR THEN RETURN ?.
    jo = NEW JsonObject().
    jo:Add("reservationId", bR.ReservationId).
    jo:Add("eventId", bR.EventId).
    jo:Add("itemId", bR.ItemId).
    jo:Add("buyerName", bR.BuyerName).
    jo:Add("quantityKg", bR.QuantityKg).
    jo:Add("status", bR.ResStatus).
    jo:Add("verdict", bR.Verdict).
    jo:Add("rejectReasons", fReasonsJson(bR.RejectReasons)).
    RUN p-add-dt (jo, "createdAt", bR.CreatedAt).
    RUN p-add-dt (jo, "decidedAt", bR.DecidedAt).
    jo:Add("requestId", bR.RequestId).
    RETURN jo.
END FUNCTION.

/* ---------- reads ---------- */
PROCEDURE h-mk-prices:
    DEFINE VARIABLE ja AS JsonArray  NO-UNDO.
    DEFINE VARIABLE jo AS JsonObject NO-UNDO.
    DEFINE BUFFER bRP FOR RetailBuyerPrice.
    ja = NEW JsonArray().
    FOR EACH bRP NO-LOCK BY bRP.Crop:
        jo = NEW JsonObject().
        jo:Add("crop", bRP.Crop).
        jo:Add("retailBuyerPricePerKg", fCentsToDec(fToCents(bRP.PricePerKg))).
        jo:Add("source", bRP.PriceSource).
        ja:Add(jo).
    END.
    RUN p-reply-named ("prices", ja).
END PROCEDURE.

PROCEDURE h-mk-events:
    DEFINE VARIABLE ja      AS JsonArray NO-UNDO.
    DEFINE VARIABLE cStatus AS CHARACTER NO-UNDO.
    DEFINE BUFFER bE FOR MarketEvent.
    cStatus = fQuery("status").
    IF cStatus = ? THEN cStatus = "".
    ja = NEW JsonArray().
    FOR EACH bE NO-LOCK BY bE.StartsAt BY bE.EventId:
        IF cStatus <> "" AND NOT fEq(bE.EventStatus, cStatus) THEN NEXT.
        ja:Add(fMkEventJson(bE.EventId)).
    END.
    RUN p-reply-named ("events", ja).
END PROCEDURE.

PROCEDURE h-mk-event:
    DEFINE INPUT PARAMETER piId AS INTEGER NO-UNDO.
    RUN p-reply-one (fMkEventJson(piId), piId, "EVENT_NOT_FOUND", "market event").
END PROCEDURE.

PROCEDURE h-mk-reservations:
    DEFINE VARIABLE ja      AS JsonArray NO-UNDO.
    DEFINE VARIABLE iEv     AS INTEGER   NO-UNDO.
    DEFINE VARIABLE iIt     AS INTEGER   NO-UNDO.
    DEFINE VARIABLE cModeE  AS CHARACTER NO-UNDO.
    DEFINE VARIABLE cModeI  AS CHARACTER NO-UNDO.
    DEFINE VARIABLE cStatus AS CHARACTER NO-UNDO.
    DEFINE BUFFER bR FOR MarketReservation.
    RUN p-query-int ("eventId", OUTPUT iEv, OUTPUT cModeE).
    RUN p-query-int ("itemId", OUTPUT iIt, OUTPUT cModeI).
    IF cModeE = "bad" OR cModeI = "bad" THEN DO:
        RUN p-reply-named ("reservations", NEW JsonArray()).
        RETURN.
    END.
    cStatus = fQuery("status").
    IF cStatus = ? THEN cStatus = "".
    ja = NEW JsonArray().
    FOR EACH bR NO-LOCK BY bR.ReservationId:
        IF cModeE = "ok" AND bR.EventId <> iEv THEN NEXT.
        IF cModeI = "ok" AND bR.ItemId <> iIt THEN NEXT.
        IF cStatus <> "" AND NOT fEq(bR.ResStatus, cStatus) THEN NEXT.
        ja:Add(fMkResJson(bR.ReservationId)).
    END.
    RUN p-reply-named ("reservations", ja).
END PROCEDURE.

/* ---------- create / edit body ---------- */
/* Reads an optional string field of at most piMax characters. plOk = FALSE after an error reply. */
PROCEDURE p-mk-opt-str:
    DEFINE INPUT  PARAMETER poJo   AS JsonObject NO-UNDO.
    DEFINE INPUT  PARAMETER pcName AS CHARACTER  NO-UNDO.
    DEFINE INPUT  PARAMETER pcField AS CHARACTER NO-UNDO.
    DEFINE INPUT  PARAMETER piMax  AS INTEGER    NO-UNDO.
    DEFINE INPUT  PARAMETER pcDef  AS CHARACTER  NO-UNDO.
    DEFINE OUTPUT PARAMETER pcVal  AS CHARACTER  NO-UNDO.
    DEFINE OUTPUT PARAMETER plOk   AS LOGICAL    NO-UNDO INITIAL FALSE.
    DEFINE VARIABLE lOk AS LOGICAL NO-UNDO.
    pcVal = pcDef.
    IF NOT poJo:Has(pcName) THEN DO:
        plOk = TRUE.
        RETURN.
    END.
    RUN get-str (poJo, pcName, OUTPUT pcVal, OUTPUT lOk).
    IF NOT lOk OR LENGTH(pcVal) > piMax THEN DO:
        RUN reply-error (400, "VALIDATION_ERROR", pcField + " must be a string of at most " + fPlain(piMax) + " characters.", pcField).
        RETURN.
    END.
    plOk = TRUE.
END PROCEDURE.

PROCEDURE p-mk-req-str:
    DEFINE INPUT  PARAMETER poJo   AS JsonObject NO-UNDO.
    DEFINE INPUT  PARAMETER pcName AS CHARACTER  NO-UNDO.
    DEFINE INPUT  PARAMETER pcField AS CHARACTER NO-UNDO.
    DEFINE INPUT  PARAMETER piMax  AS INTEGER    NO-UNDO.
    DEFINE OUTPUT PARAMETER pcVal  AS CHARACTER  NO-UNDO.
    DEFINE OUTPUT PARAMETER plOk   AS LOGICAL    NO-UNDO INITIAL FALSE.
    DEFINE VARIABLE lOk AS LOGICAL NO-UNDO.
    RUN get-str (poJo, pcName, OUTPUT pcVal, OUTPUT lOk).
    IF NOT lOk OR LENGTH(pcVal) < 1 OR LENGTH(pcVal) > piMax THEN DO:
        RUN reply-error (400, "VALIDATION_ERROR", pcField + " must be a string of 1 to " + fPlain(piMax) + " characters.", pcField).
        RETURN.
    END.
    plOk = TRUE.
END PROCEDURE.

/* Validates the event body and fills ttMkItem. Same order of checks as parseEvent() in market-handler.js. */
PROCEDURE p-mk-parse:
    DEFINE OUTPUT PARAMETER pcName  AS CHARACTER   NO-UNDO.
    DEFINE OUTPUT PARAMETER pcVenue AS CHARACTER   NO-UNDO.
    DEFINE OUTPUT PARAMETER pcArea  AS CHARACTER   NO-UNDO.
    DEFINE OUTPUT PARAMETER pcNotes AS CHARACTER   NO-UNDO.
    DEFINE OUTPUT PARAMETER ptStart AS DATETIME-TZ NO-UNDO.
    DEFINE OUTPUT PARAMETER ptEnd   AS DATETIME-TZ NO-UNDO.
    DEFINE OUTPUT PARAMETER piFarm  AS INTEGER     NO-UNDO.
    DEFINE OUTPUT PARAMETER plOk    AS LOGICAL     NO-UNDO INITIAL FALSE.
    DEFINE VARIABLE lOk   AS LOGICAL    NO-UNDO.
    DEFINE VARIABLE c     AS CHARACTER  NO-UNDO.
    DEFINE VARIABLE d     AS DECIMAL    NO-UNDO.
    DEFINE VARIABLE jaIt  AS JsonArray  NO-UNDO.
    DEFINE VARIABLE joIt  AS JsonObject NO-UNDO.
    DEFINE VARIABLE i     AS INTEGER    NO-UNDO.
    DEFINE VARIABLE cF    AS CHARACTER  NO-UNDO.
    DEFINE VARIABLE cCrop AS CHARACTER  NO-UNDO.
    DEFINE VARIABLE cLab  AS CHARACTER  NO-UNDO.
    DEFINE VARIABLE iQty  AS INTEGER    NO-UNDO.
    DEFINE VARIABLE iCents AS INT64     NO-UNDO.
    DEFINE VARIABLE iLot  AS INTEGER    NO-UNDO.
    EMPTY TEMP-TABLE ttMkItem.
    RUN p-mk-req-str (goBody, "eventName", "eventName", 80, OUTPUT pcName, OUTPUT lOk).
    IF NOT lOk THEN RETURN.
    RUN p-mk-req-str (goBody, "venue", "venue", 120, OUTPUT pcVenue, OUTPUT lOk).
    IF NOT lOk THEN RETURN.
    RUN p-mk-opt-str (goBody, "area", "area", 80, "", OUTPUT pcArea, OUTPUT lOk).
    IF NOT lOk THEN RETURN.
    RUN p-mk-opt-str (goBody, "notes", "notes", 500, "", OUTPUT pcNotes, OUTPUT lOk).
    IF NOT lOk THEN RETURN.
    RUN get-str (goBody, "startsAt", OUTPUT c, OUTPUT lOk).
    IF lOk THEN ptStart = fParseIso(c).
    IF NOT lOk OR ptStart = ? THEN DO:
        RUN reply-error (400, "VALIDATION_ERROR", "startsAt must be ISO 8601 UTC, e.g. 2026-10-31T06:00:00Z.", "startsAt").
        RETURN.
    END.
    RUN get-str (goBody, "endsAt", OUTPUT c, OUTPUT lOk).
    IF lOk THEN ptEnd = fParseIso(c).
    IF NOT lOk OR ptEnd = ? OR ptEnd <= ptStart THEN DO:
        RUN reply-error (400, "VALIDATION_ERROR", "endsAt must be ISO 8601 UTC and later than startsAt.", "endsAt").
        RETURN.
    END.
    piFarm = 1.
    IF goBody:Has("farmId") THEN DO:
        RUN p-read-posint ("farmId", "farmId must be an integer.", 2147483647, OUTPUT piFarm, OUTPUT lOk).
        IF NOT lOk THEN RETURN.
    END.
    IF NOT goBody:Has("items") OR goBody:GetType("items") <> JsonDataType:ARRAY THEN lOk = FALSE.
    ELSE DO:
        jaIt = goBody:GetJsonArray("items").
        lOk = jaIt:Length >= 1 AND jaIt:Length <= {&MARKET_MAX_ITEMS}.
    END.
    IF NOT lOk THEN DO:
        RUN reply-error (400, "VALIDATION_ERROR", "items must be a list of 1 to " + fPlain({&MARKET_MAX_ITEMS}) + " items.", "items").
        RETURN.
    END.
    DO i = 1 TO jaIt:Length:
        cF = "items[" + fPlain(i - 1) + "]".
        IF jaIt:GetType(i) <> JsonDataType:OBJECT THEN DO:
            RUN reply-error (400, "VALIDATION_ERROR", cF + " must be an object.", cF).
            RETURN.
        END.
        joIt = jaIt:GetJsonObject(i).
        RUN p-mk-req-str (joIt, "crop", cF + ".crop", 40, OUTPUT cCrop, OUTPUT lOk).
        IF NOT lOk THEN RETURN.
        RUN p-mk-opt-str (joIt, "label", cF + ".label", 80, "", OUTPUT cLab, OUTPUT lOk).
        IF NOT lOk THEN RETURN.
        IF cLab = "" THEN cLab = cCrop.
        RUN get-num (joIt, "quantityKg", OUTPUT d, OUTPUT lOk).
        IF NOT lOk OR d <> TRUNCATE(d, 0) OR d < 1 OR d > {&MAX_KG} THEN DO:
            RUN reply-error (400, "VALIDATION_ERROR", cF + ".quantityKg must be a whole number of kg from 1 to " + fPlain({&MAX_KG}) + ".", cF + ".quantityKg").
            RETURN.
        END.
        iQty = INTEGER(d).
        RUN get-num (joIt, "pricePerKg", OUTPUT d, OUTPUT lOk).
        IF NOT lOk OR d <> ROUND(d, 2) OR d <= 0 OR d > {&MAX_AMOUNT_RAND} THEN DO:
            RUN reply-error (400, "VALIDATION_ERROR", cF + ".pricePerKg must be a positive number in Rand with at most 2 decimals.", cF + ".pricePerKg").
            RETURN.
        END.
        iCents = fToCents(d).
        iLot = 0.
        IF joIt:Has("lotId") AND joIt:GetType("lotId") <> JsonDataType:NULL THEN DO:
            RUN get-num (joIt, "lotId", OUTPUT d, OUTPUT lOk).
            IF NOT lOk OR d <> TRUNCATE(d, 0) OR d < 1 OR d > 2147483647 THEN DO:
                RUN reply-error (400, "VALIDATION_ERROR", cF + ".lotId must be an integer.", cF + ".lotId").
                RETURN.
            END.
            iLot = INTEGER(d).
        END.
        CREATE ttMkItem.
        ASSIGN ttMkItem.mkSeq = i ttMkItem.mkCrop = cCrop ttMkItem.mkLabel = cLab
               ttMkItem.mkQty = iQty ttMkItem.mkCents = iCents ttMkItem.mkLot = iLot.
    END.
    plOk = TRUE.
END PROCEDURE.

/* ---------- create (piId = 0, plCreate) or edit (replace event fields and items; the rules run again) ---------- */
PROCEDURE h-mk-event-save:
    DEFINE INPUT PARAMETER piId     AS INTEGER NO-UNDO.
    DEFINE INPUT PARAMETER plCreate AS LOGICAL NO-UNDO.
    DEFINE VARIABLE cName  AS CHARACTER   NO-UNDO.
    DEFINE VARIABLE cVenue AS CHARACTER   NO-UNDO.
    DEFINE VARIABLE cArea  AS CHARACTER   NO-UNDO.
    DEFINE VARIABLE cNotes AS CHARACTER   NO-UNDO.
    DEFINE VARIABLE tStart AS DATETIME-TZ NO-UNDO.
    DEFINE VARIABLE tEnd   AS DATETIME-TZ NO-UNDO.
    DEFINE VARIABLE iFarm  AS INTEGER     NO-UNDO.
    DEFINE VARIABLE lOk    AS LOGICAL     NO-UNDO.
    DEFINE VARIABLE tAsOf  AS DATETIME-TZ NO-UNDO.
    DEFINE VARIABLE cReq   AS CHARACTER   NO-UNDO.
    DEFINE VARIABLE cActor AS CHARACTER   NO-UNDO.
    DEFINE VARIABLE joV    AS JsonObject  NO-UNDO.
    DEFINE VARIABLE cVerdict AS CHARACTER NO-UNDO.
    DEFINE VARIABLE cReasons AS CHARACTER NO-UNDO.
    DEFINE VARIABLE iEv    AS INTEGER     NO-UNDO.
    DEFINE VARIABLE iCount     AS INTEGER     NO-UNDO.
    DEFINE VARIABLE iAud   AS INTEGER     NO-UNDO.
    DEFINE BUFFER bE FOR MarketEvent.
    DEFINE BUFFER bI FOR MarketItem.
    DEFINE BUFFER bR FOR MarketReservation.
    DEFINE BUFFER bF FOR Farm.
    DEFINE BUFFER bL FOR HarvestLot.
    RUN p-mk-parse (OUTPUT cName, OUTPUT cVenue, OUTPUT cArea, OUTPUT cNotes, OUTPUT tStart, OUTPUT tEnd, OUTPUT iFarm, OUTPUT lOk).
    IF NOT lOk THEN RETURN.
    RUN p-coop-common (OUTPUT tAsOf, OUTPUT cReq, OUTPUT cActor, OUTPUT lOk).
    IF NOT lOk THEN RETURN.
    IF NOT plCreate THEN DO:
        IF piId = ? THEN DO:
            RUN p-not-found (?, "EVENT_NOT_FOUND", "market event").
            RETURN.
        END.
        FIND bE WHERE bE.EventId = piId NO-LOCK NO-ERROR.
        IF NOT AVAILABLE bE THEN DO:
            RUN p-not-found (piId, "EVENT_NOT_FOUND", "market event").
            RETURN.
        END.
        IF fEq(bE.EventStatus, "cancelled") THEN DO:
            RUN reply-error (409, "ALREADY_DECIDED", "Event is already cancelled.", ?).
            RETURN.
        END.
        FOR EACH bR NO-LOCK WHERE bR.EventId = piId:
            IF fEq(bR.ResStatus, "confirmed") THEN DO:
                RUN reply-error (409, "HAS_RESERVATIONS", "This event already has reservations. Cancel it and create a new one instead.", ?).
                RETURN.
            END.
        END.
    END.
    FIND bF WHERE bF.FarmId = iFarm NO-LOCK NO-ERROR.
    IF NOT AVAILABLE bF THEN DO:
        RUN p-not-found (iFarm, "FARM_NOT_FOUND", "farm").
        RETURN.
    END.
    FOR EACH ttMkItem BY ttMkItem.mkSeq:
        IF ttMkItem.mkLot = 0 THEN NEXT.
        FIND bL WHERE bL.LotId = ttMkItem.mkLot NO-LOCK NO-ERROR.
        IF NOT AVAILABLE bL THEN DO:
            RUN p-not-found (ttMkItem.mkLot, "LOT_NOT_FOUND", "harvest lot").
            RETURN.
        END.
    END.
    RUN p-mk-check (tStart, tAsOf, (IF plCreate THEN 0 ELSE piId), OUTPUT joV).
    cVerdict = joV:GetCharacter("verdict").
    RUN p-reasons-text (joV, OUTPUT cReasons).
    DO TRANSACTION:
        IF plCreate THEN CREATE bE.
        ELSE DO:
            FIND bE WHERE bE.EventId = piId EXCLUSIVE-LOCK.
            FOR EACH bI EXCLUSIVE-LOCK WHERE bI.EventId = piId:
                DELETE bI.
            END.
        END.
        /* one ASSIGN, so a new record is complete (mandatory fields set) before it is written */
        ASSIGN bE.EventId = (IF plCreate THEN NEXT-VALUE(MarketEventSeq) ELSE bE.EventId)
               bE.CreatedAt = (IF plCreate THEN tAsOf ELSE bE.CreatedAt)
               bE.FarmId = iFarm
               bE.EventName = cName
               bE.VenueName = cVenue
               bE.VenueArea = cArea
               bE.EventNotes = cNotes
               bE.StartsAt = tStart
               bE.EndsAt = tEnd
               bE.EventStatus = (IF fEq(cVerdict, "approved_by_rules") THEN "pending_approval" ELSE "rejected")
               bE.Verdict = cVerdict
               bE.RejectReasons = cReasons
               bE.DecidedAt = ?
               bE.RequestId = cReq
               bE.IsExample = FALSE.
        iEv = bE.EventId.
        iCount = 0.
        FOR EACH ttMkItem BY ttMkItem.mkSeq:
            CREATE bI.
            ASSIGN bI.ItemId = NEXT-VALUE(MarketItemSeq)
                   bI.EventId = iEv
                   bI.ItemOrder = ttMkItem.mkSeq
                   bI.Crop = ttMkItem.mkCrop
                   bI.ItemLabel = ttMkItem.mkLabel
                   bI.QuantityKg = ttMkItem.mkQty
                   bI.PricePerKg = fCentsToDec(ttMkItem.mkCents)
                   bI.LotId = ttMkItem.mkLot.
            RELEASE bI.
            iCount = iCount + 1.
        END.
        RELEASE bE.
    END.
    IF NOT plCreate THEN RUN audit (cReq, cActor, "market_event_edited", "event " + fPlain(iEv), tAsOf, OUTPUT iAud).
    RUN audit (cReq, "abl-rules", "market_rule_check", "event " + fPlain(iEv) + " " + fPlain(iCount) + " item(s) => " + cVerdict, tAsOf, OUTPUT iAud).
    RUN reply ((IF plCreate THEN 201 ELSE 200), fMkEventJson(iEv)).
END PROCEDURE.

/* ---------- farmer decision: approve (publish), reject (decline), cancel ---------- */
PROCEDURE h-mk-event-decide:
    DEFINE INPUT PARAMETER piId AS INTEGER NO-UNDO.
    DEFINE VARIABLE cDec    AS CHARACTER   NO-UNDO.
    DEFINE VARIABLE lOk     AS LOGICAL     NO-UNDO.
    DEFINE VARIABLE tAsOf   AS DATETIME-TZ NO-UNDO.
    DEFINE VARIABLE cReq    AS CHARACTER   NO-UNDO.
    DEFINE VARIABLE cActor  AS CHARACTER   NO-UNDO.
    DEFINE VARIABLE cStatus AS CHARACTER   NO-UNDO.
    DEFINE VARIABLE joV     AS JsonObject  NO-UNDO.
    DEFINE VARIABLE jo      AS JsonObject  NO-UNDO.
    DEFINE VARIABLE cReasons AS CHARACTER  NO-UNDO.
    DEFINE VARIABLE iAud    AS INTEGER     NO-UNDO.
    DEFINE VARIABLE iK      AS INTEGER     NO-UNDO.
    DEFINE BUFFER bE FOR MarketEvent.
    DEFINE BUFFER bI FOR MarketItem.
    DEFINE BUFFER bR FOR MarketReservation.
    RUN get-str (goBody, "decision", OUTPUT cDec, OUTPUT lOk).
    IF NOT lOk OR NOT (fEq(cDec, "approve") OR fEq(cDec, "reject") OR fEq(cDec, "cancel")) THEN DO:
        RUN reply-error (400, "VALIDATION_ERROR", "decision must be approve, reject or cancel.", "decision").
        RETURN.
    END.
    RUN p-coop-common (OUTPUT tAsOf, OUTPUT cReq, OUTPUT cActor, OUTPUT lOk).
    IF NOT lOk THEN RETURN.
    IF piId = ? THEN DO:
        RUN p-not-found (?, "EVENT_NOT_FOUND", "market event").
        RETURN.
    END.
    FIND bE WHERE bE.EventId = piId NO-LOCK NO-ERROR.
    IF NOT AVAILABLE bE THEN DO:
        RUN p-not-found (piId, "EVENT_NOT_FOUND", "market event").
        RETURN.
    END.
    cStatus = bE.EventStatus.
    IF fEq(cDec, "approve") THEN DO:
        IF fEq(cStatus, "rejected") THEN DO:
            RUN reply-error (409, "NOT_APPROVABLE", "This event was rejected by the rules and cannot be published. Edit it first.", ?).
            RETURN.
        END.
        IF NOT fEq(cStatus, "pending_approval") THEN DO:
            RUN reply-error (409, "ALREADY_DECIDED", "Event is already " + cStatus + ".", ?).
            RETURN.
        END.
        EMPTY TEMP-TABLE ttMkItem.
        FOR EACH bI NO-LOCK WHERE bI.EventId = piId BY bI.ItemOrder BY bI.ItemId:
            CREATE ttMkItem.
            ASSIGN ttMkItem.mkSeq = bI.ItemOrder ttMkItem.mkCrop = bI.Crop ttMkItem.mkLabel = bI.ItemLabel
                   ttMkItem.mkQty = bI.QuantityKg ttMkItem.mkCents = fToCents(bI.PricePerKg) ttMkItem.mkLot = bI.LotId.
        END.
        RUN p-mk-check (bE.StartsAt, tAsOf, piId, OUTPUT joV).
        DO TRANSACTION:
            FIND bE WHERE bE.EventId = piId EXCLUSIVE-LOCK.
            IF NOT fEq(joV:GetCharacter("verdict"), "approved_by_rules") THEN DO:
                RUN p-reasons-text (joV, OUTPUT cReasons).
                ASSIGN bE.EventStatus = "rejected"
                       bE.Verdict = joV:GetCharacter("verdict")
                       bE.RejectReasons = cReasons
                       bE.DecidedAt = tAsOf.
            END.
            ELSE ASSIGN bE.EventStatus = "published" bE.DecidedAt = tAsOf.
            RELEASE bE.
        END.
        IF NOT fEq(joV:GetCharacter("verdict"), "approved_by_rules") THEN DO:
            RUN audit (cReq, cActor, "market_publish_blocked_by_rules", "event " + fPlain(piId), tAsOf, OUTPUT iAud).
            jo = fMkEventJson(piId).
            jo:Add("error", "NOT_APPROVABLE").
            RUN reply (409, jo).
            RETURN.
        END.
        RUN audit (cReq, cActor, "market_event_published", "event " + fPlain(piId), tAsOf, OUTPUT iAud).
        RUN reply (200, fMkEventJson(piId)).
        RETURN.
    END.
    IF fEq(cDec, "reject") THEN DO:
        IF NOT fEq(cStatus, "pending_approval") THEN DO:
            RUN reply-error (409, "ALREADY_DECIDED", "Event is already " + cStatus + ".", ?).
            RETURN.
        END.
        DO TRANSACTION:
            FIND bE WHERE bE.EventId = piId EXCLUSIVE-LOCK.
            ASSIGN bE.EventStatus = "declined" bE.DecidedAt = tAsOf.
            RELEASE bE.
        END.
        RUN audit (cReq, cActor, "market_event_declined", "event " + fPlain(piId), tAsOf, OUTPUT iAud).
        RUN reply (200, fMkEventJson(piId)).
        RETURN.
    END.
    /* cancel */
    IF fEq(cStatus, "cancelled") THEN DO:
        RUN reply-error (409, "ALREADY_DECIDED", "Event is already cancelled.", ?).
        RETURN.
    END.
    IF NOT fMkActive(cStatus) THEN DO:
        RUN reply-error (409, "NOT_CANCELLABLE", "Only a pending or published event can be cancelled (this one is " + cStatus + ").", ?).
        RETURN.
    END.
    iK = 0.
    DO TRANSACTION:
        FOR EACH bR EXCLUSIVE-LOCK WHERE bR.EventId = piId:
            IF NOT fEq(bR.ResStatus, "confirmed") THEN NEXT.
            ASSIGN bR.ResStatus = "cancelled" bR.DecidedAt = tAsOf.
            iK = iK + 1.
        END.
        FIND bE WHERE bE.EventId = piId EXCLUSIVE-LOCK.
        ASSIGN bE.EventStatus = "cancelled" bE.DecidedAt = tAsOf.
        RELEASE bE.
    END.
    RUN audit (cReq, cActor, "market_event_cancelled", "event " + fPlain(piId) + ": " + fPlain(iK) + " reservation(s) cancelled", tAsOf, OUTPUT iAud).
    RUN reply (200, fMkEventJson(piId)).
END PROCEDURE.

/* ---------- reservations ---------- */
PROCEDURE h-mk-res-create:
    DEFINE VARIABLE iItem   AS INTEGER     NO-UNDO.
    DEFINE VARIABLE cBuyer  AS CHARACTER   NO-UNDO.
    DEFINE VARIABLE iQty    AS INTEGER     NO-UNDO.
    DEFINE VARIABLE lOk     AS LOGICAL     NO-UNDO.
    DEFINE VARIABLE tAsOf   AS DATETIME-TZ NO-UNDO.
    DEFINE VARIABLE cReq    AS CHARACTER   NO-UNDO.
    DEFINE VARIABLE cActor  AS CHARACTER   NO-UNDO.
    DEFINE VARIABLE joV     AS JsonObject  NO-UNDO.
    DEFINE VARIABLE cVerdict AS CHARACTER  NO-UNDO.
    DEFINE VARIABLE cReasons AS CHARACTER  NO-UNDO.
    DEFINE VARIABLE iNew    AS INTEGER     NO-UNDO.
    DEFINE VARIABLE iAud    AS INTEGER     NO-UNDO.
    DEFINE BUFFER bI FOR MarketItem.
    DEFINE BUFFER bR FOR MarketReservation.
    RUN p-read-posint ("itemId", "itemId must be an integer.", 2147483647, OUTPUT iItem, OUTPUT lOk).
    IF NOT lOk THEN RETURN.
    RUN p-mk-req-str (goBody, "buyerName", "buyerName", 80, OUTPUT cBuyer, OUTPUT lOk).
    IF NOT lOk THEN RETURN.
    RUN p-read-posint ("quantityKg", "quantityKg must be a whole number of kg from 1 to " + fPlain({&MAX_KG}) + ".", {&MAX_KG}, OUTPUT iQty, OUTPUT lOk).
    IF NOT lOk THEN RETURN.
    RUN p-coop-common (OUTPUT tAsOf, OUTPUT cReq, OUTPUT cActor, OUTPUT lOk).
    IF NOT lOk THEN RETURN.
    FIND bI WHERE bI.ItemId = iItem NO-LOCK NO-ERROR.
    IF NOT AVAILABLE bI THEN DO:
        RUN p-not-found (iItem, "ITEM_NOT_FOUND", "market item").
        RETURN.
    END.
    RUN p-mk-check-res (iItem, iQty, tAsOf, OUTPUT joV).
    cVerdict = joV:GetCharacter("verdict").
    RUN p-reasons-text (joV, OUTPUT cReasons).
    DO TRANSACTION:
        CREATE bR.
        ASSIGN bR.ReservationId = NEXT-VALUE(ReservationSeq)
               bR.EventId = bI.EventId
               bR.ItemId = bI.ItemId
               bR.BuyerName = cBuyer
               bR.QuantityKg = iQty
               bR.ResStatus = (IF fEq(cVerdict, "approved_by_rules") THEN "confirmed" ELSE "rejected")
               bR.Verdict = cVerdict
               bR.RejectReasons = cReasons
               bR.CreatedAt = tAsOf
               bR.RequestId = cReq
               bR.IsExample = FALSE.
        iNew = bR.ReservationId.
        RELEASE bR.
    END.
    RUN audit (cReq, "abl-rules", "reservation_rule_check",
        "reservation " + fPlain(iNew) + " item " + fPlain(iItem) + " " + fPlain(iQty) + " kg => " + cVerdict, tAsOf, OUTPUT iAud).
    RUN reply (201, fMkResJson(iNew)).
END PROCEDURE.

PROCEDURE h-mk-res-decide:
    DEFINE INPUT PARAMETER piId AS INTEGER NO-UNDO.
    DEFINE VARIABLE cDec   AS CHARACTER   NO-UNDO.
    DEFINE VARIABLE lOk    AS LOGICAL     NO-UNDO.
    DEFINE VARIABLE tAsOf  AS DATETIME-TZ NO-UNDO.
    DEFINE VARIABLE cReq   AS CHARACTER   NO-UNDO.
    DEFINE VARIABLE cActor AS CHARACTER   NO-UNDO.
    DEFINE VARIABLE iAud   AS INTEGER     NO-UNDO.
    DEFINE BUFFER bR FOR MarketReservation.
    RUN get-str (goBody, "decision", OUTPUT cDec, OUTPUT lOk).
    IF NOT lOk OR NOT fEq(cDec, "cancel") THEN DO:
        RUN reply-error (400, "VALIDATION_ERROR", "decision must be cancel.", "decision").
        RETURN.
    END.
    RUN p-coop-common (OUTPUT tAsOf, OUTPUT cReq, OUTPUT cActor, OUTPUT lOk).
    IF NOT lOk THEN RETURN.
    IF piId = ? THEN DO:
        RUN p-not-found (?, "RESERVATION_NOT_FOUND", "reservation").
        RETURN.
    END.
    FIND bR WHERE bR.ReservationId = piId NO-LOCK NO-ERROR.
    IF NOT AVAILABLE bR THEN DO:
        RUN p-not-found (piId, "RESERVATION_NOT_FOUND", "reservation").
        RETURN.
    END.
    IF NOT fEq(bR.ResStatus, "confirmed") THEN DO:
        RUN reply-error (409, "ALREADY_DECIDED", "Reservation is already " + bR.ResStatus + ".", ?).
        RETURN.
    END.
    DO TRANSACTION:
        FIND bR WHERE bR.ReservationId = piId EXCLUSIVE-LOCK.
        ASSIGN bR.ResStatus = "cancelled" bR.DecidedAt = tAsOf.
        RELEASE bR.
    END.
    RUN audit (cReq, cActor, "reservation_cancelled", "reservation " + fPlain(piId), tAsOf, OUTPUT iAud).
    RUN reply (200, fMkResJson(piId)).
END PROCEDURE.
