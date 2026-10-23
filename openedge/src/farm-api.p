/*------------------------------------------------------------------------
  farm-api.p  -  Mzansi Farmer Ops: OpenEdge business rules + data service.

  One entry point used by (a) the PASOE WebHandler (web/FarmHandler.cls) and
  (b) the batch contract test runner (tests/run-contract.p).

  RUN farm-api.p (method, path, body, OUTPUT status, OUTPUT json-response).
  Path examples: /farm/plots/1/readings?limit=5, /farm/validate, ...
  The REST contract is documented in docs/OE-CONTRACT.md.

  RULES (all numbers come from the OpenEdge database, never from the AI):
    PLOT_NOT_FOUND, ACTION_NOT_ALLOWED, LITRES_OUT_OF_RANGE, NO_SENSOR_DATA,
    SENSOR_STALE, SOIL_NOT_DRY, RAIN_DETECTED, WATER_BUDGET_EXCEEDED
  EXAMPLE DATA ONLY: the farm, plots and readings are fictional.
------------------------------------------------------------------------*/
USING Progress.Json.ObjectModel.JsonObject.
USING Progress.Json.ObjectModel.JsonArray.
USING Progress.Json.ObjectModel.JsonDataType.
USING Progress.Json.ObjectModel.ObjectModelParser.

DEFINE INPUT  PARAMETER pcMethod   AS CHARACTER NO-UNDO.
DEFINE INPUT  PARAMETER pcPath     AS CHARACTER NO-UNDO.
DEFINE INPUT  PARAMETER pcBody     AS LONGCHAR  NO-UNDO.
DEFINE OUTPUT PARAMETER piStatus   AS INTEGER   NO-UNDO INITIAL 500.
DEFINE OUTPUT PARAMETER pcResponse AS LONGCHAR  NO-UNDO.

/* ---- named constants (keep identical to mock-pasoe/rules.js) ---- */
&SCOPED-DEFINE STALE_READING_MINUTES 15
&SCOPED-DEFINE BUDGET_WINDOW_DAYS 7
&SCOPED-DEFINE ALLOWED_ACTIONS "irrigate,hold,notify"

DEFINE VARIABLE giStatus AS INTEGER    NO-UNDO.
DEFINE VARIABLE goResp   AS JsonObject NO-UNDO.
DEFINE VARIABLE goBody   AS JsonObject NO-UNDO.
DEFINE VARIABLE gcQuery  AS CHARACTER  NO-UNDO.
DEFINE VARIABLE gcSegs   AS CHARACTER  NO-UNDO.   /* path without /farm and query */
DEFINE VARIABLE gcResp   AS LONGCHAR   NO-UNDO.

/* ---------- helpers ---------- */
{iso.i}

FUNCTION fQuery RETURNS CHARACTER (INPUT pcName AS CHARACTER):
    DEFINE VARIABLE i AS INTEGER NO-UNDO.
    DEFINE VARIABLE cPair AS CHARACTER NO-UNDO.
    DO i = 1 TO NUM-ENTRIES(gcQuery, "&"):
        cPair = ENTRY(i, gcQuery, "&").
        IF ENTRY(1, cPair, "=") = pcName AND NUM-ENTRIES(cPair, "=") > 1 THEN
            RETURN ENTRY(2, cPair, "=").
    END.
    RETURN ?.
END FUNCTION.

PROCEDURE reply:
    DEFINE INPUT PARAMETER piStat AS INTEGER NO-UNDO.
    DEFINE INPUT PARAMETER poJson AS JsonObject NO-UNDO.
    giStatus = piStat.
    goResp = poJson.
END PROCEDURE.

PROCEDURE reply-error:
    DEFINE INPUT PARAMETER piStat  AS INTEGER NO-UNDO.
    DEFINE INPUT PARAMETER pcCode  AS CHARACTER NO-UNDO.
    DEFINE INPUT PARAMETER pcMsg   AS CHARACTER NO-UNDO.
    DEFINE INPUT PARAMETER pcField AS CHARACTER NO-UNDO.
    DEFINE VARIABLE jo AS JsonObject NO-UNDO.
    jo = NEW JsonObject().
    jo:Add("error", pcCode).
    jo:Add("message", pcMsg).
    IF pcField <> ? AND pcField <> "" THEN jo:Add("field", pcField).
    RUN reply (piStat, jo).
END PROCEDURE.

PROCEDURE audit:
    DEFINE INPUT PARAMETER pcRequestId AS CHARACTER NO-UNDO.
    DEFINE INPUT PARAMETER pcActor     AS CHARACTER NO-UNDO.
    DEFINE INPUT PARAMETER pcEvent     AS CHARACTER NO-UNDO.
    DEFINE INPUT PARAMETER pcDetail    AS CHARACTER NO-UNDO.
    DEFINE INPUT PARAMETER ptAt        AS DATETIME-TZ NO-UNDO.
    DEFINE OUTPUT PARAMETER piId       AS INTEGER NO-UNDO.
    CREATE AuditLog.
    ASSIGN AuditLog.AuditId   = NEXT-VALUE(AuditSeq)
           AuditLog.LoggedAt        = (IF ptAt = ? THEN NOW ELSE ptAt)
           AuditLog.RequestId = pcRequestId
           AuditLog.Actor     = pcActor
           AuditLog.Event     = pcEvent
           AuditLog.Detail    = SUBSTRING(pcDetail, 1, 4000).
    piId = AuditLog.AuditId.
    RELEASE AuditLog.
END PROCEDURE.

/* Typed getters. pcName must exist with the right JSON type. */
PROCEDURE get-str:
    DEFINE INPUT  PARAMETER poJo   AS JsonObject NO-UNDO.
    DEFINE INPUT  PARAMETER pcName AS CHARACTER NO-UNDO.
    DEFINE OUTPUT PARAMETER pcVal  AS CHARACTER NO-UNDO.
    DEFINE OUTPUT PARAMETER plOk   AS LOGICAL NO-UNDO.
    plOk = poJo:Has(pcName) AND poJo:GetType(pcName) = JsonDataType:STRING.
    IF plOk THEN pcVal = poJo:GetCharacter(pcName).
END PROCEDURE.

PROCEDURE get-num:
    DEFINE INPUT  PARAMETER poJo   AS JsonObject NO-UNDO.
    DEFINE INPUT  PARAMETER pcName AS CHARACTER NO-UNDO.
    DEFINE OUTPUT PARAMETER pdVal  AS DECIMAL NO-UNDO.
    DEFINE OUTPUT PARAMETER plOk   AS LOGICAL NO-UNDO.
    plOk = poJo:Has(pcName) AND poJo:GetType(pcName) = JsonDataType:NUMBER.
    IF plOk THEN pdVal = poJo:GetDecimal(pcName).
END PROCEDURE.

/* ---------- JSON builders ---------- */
FUNCTION fPlotJson RETURNS JsonObject (INPUT piPlotId AS INTEGER):
    DEFINE VARIABLE jo AS JsonObject NO-UNDO.
    FIND Plot WHERE Plot.PlotId = piPlotId NO-LOCK NO-ERROR.
    IF NOT AVAILABLE Plot THEN RETURN ?.
    jo = NEW JsonObject().
    jo:Add("plotId", Plot.PlotId).
    jo:Add("farmId", Plot.FarmId).
    jo:Add("plotName", Plot.PlotName).
    jo:Add("crop", Plot.Crop).
    jo:Add("areaHa", Plot.AreaHa).
    jo:Add("maxIrrigationLitres", Plot.MaxIrrigationLitres).
    jo:Add("dryThresholdPct", Plot.DryThresholdPct).
    jo:Add("weeklyWaterBudgetL", Plot.WeeklyWaterBudgetL).
    RETURN jo.
END FUNCTION.

FUNCTION fSuggJson RETURNS JsonObject (INPUT piId AS INTEGER):
    DEFINE VARIABLE jo AS JsonObject NO-UNDO.
    DEFINE VARIABLE ja AS JsonArray  NO-UNDO.
    DEFINE VARIABLE oParser AS ObjectModelParser NO-UNDO.
    FIND AiSuggestion WHERE AiSuggestion.SuggestionId = piId NO-LOCK NO-ERROR.
    IF NOT AVAILABLE AiSuggestion THEN RETURN ?.
    jo = NEW JsonObject().
    jo:Add("suggestionId", AiSuggestion.SuggestionId).
    jo:Add("plotId", AiSuggestion.PlotId).
    jo:Add("action", AiSuggestion.Action).
    jo:Add("litres", AiSuggestion.Litres).
    jo:Add("reason", AiSuggestion.Reason).
    jo:Add("provider", AiSuggestion.Provider).
    jo:Add("status", AiSuggestion.SuggStatus).
    jo:Add("verdict", AiSuggestion.Verdict).
    IF AiSuggestion.RejectReasons > "" THEN DO:
        oParser = NEW ObjectModelParser().
        ja = CAST(oParser:Parse(AiSuggestion.RejectReasons), JsonArray).
    END.
    ELSE ja = NEW JsonArray().
    jo:Add("rejectReasons", ja).
    jo:Add("createdAt", fIso(AiSuggestion.CreatedAt)).
    IF AiSuggestion.DecidedAt = ? THEN jo:AddNull("decidedAt").
    ELSE jo:Add("decidedAt", fIso(AiSuggestion.DecidedAt)).
    jo:Add("requestId", AiSuggestion.RequestId).
    RETURN jo.
END FUNCTION.

/* ---------- THE RULES ---------- */
PROCEDURE do-validate:
    DEFINE INPUT  PARAMETER piPlotId AS INTEGER NO-UNDO.
    DEFINE INPUT  PARAMETER pcAction AS CHARACTER NO-UNDO.
    DEFINE INPUT  PARAMETER pdLitres AS DECIMAL NO-UNDO.
    DEFINE INPUT  PARAMETER ptAsOf   AS DATETIME-TZ NO-UNDO.
    DEFINE OUTPUT PARAMETER poResult AS JsonObject NO-UNDO.

    /* explicit buffer: the caller (h-decision) may hold an exclusive lock on AiSuggestion */
    DEFINE BUFFER bSugg FOR AiSuggestion.
    DEFINE VARIABLE joFacts   AS JsonObject NO-UNDO.
    DEFINE VARIABLE jaReasons AS JsonArray  NO-UNDO.
    DEFINE VARIABLE iAge      AS INTEGER NO-UNDO.
    DEFINE VARIABLE dUsed     AS DECIMAL NO-UNDO INITIAL 0.
    DEFINE VARIABLE lHaveFresh AS LOGICAL NO-UNDO INITIAL FALSE.
    DEFINE VARIABLE lIrrigate AS LOGICAL NO-UNDO.
    DEFINE VARIABLE lHaveReading AS LOGICAL NO-UNDO INITIAL FALSE.
    DEFINE VARIABLE dSoil AS DECIMAL NO-UNDO.
    DEFINE VARIABLE lRaining AS LOGICAL NO-UNDO INITIAL FALSE.

    poResult  = NEW JsonObject().
    joFacts   = NEW JsonObject().
    jaReasons = NEW JsonArray().

    FIND Plot WHERE Plot.PlotId = piPlotId NO-LOCK NO-ERROR.
    IF NOT AVAILABLE Plot THEN DO:
        RUN add-reason (jaReasons, "PLOT_NOT_FOUND", SUBSTITUTE("No plot with id &1.", piPlotId)).
        poResult:Add("verdict", "rejected_by_rules").
        poResult:Add("rejectReasons", jaReasons).
        poResult:Add("facts", joFacts).
        RETURN.
    END.

    joFacts:Add("plotName", Plot.PlotName).
    joFacts:Add("dryThresholdPct", Plot.DryThresholdPct).
    joFacts:Add("maxIrrigationLitres", Plot.MaxIrrigationLitres).
    joFacts:Add("weeklyWaterBudgetL", Plot.WeeklyWaterBudgetL).
    joFacts:Add("staleLimitMinutes", {&STALE_READING_MINUTES}).

    lIrrigate = (pcAction = "irrigate").

    /* water used in the budget window (approved IRRIGATE suggestions only: hold/notify never use water,
       even if a litres value was stored with them) */
    FOR EACH bSugg NO-LOCK WHERE bSugg.PlotId = piPlotId
         AND bSugg.SuggStatus = "approved"
         AND bSugg.Action = "irrigate"
         AND bSugg.DecidedAt >= ADD-INTERVAL(ptAsOf, - {&BUDGET_WINDOW_DAYS}, "days"):
        dUsed = dUsed + bSugg.Litres.
    END.
    joFacts:Add("usedLast7DaysL", dUsed).

    /* latest reading */
    FOR FIRST SensorReading NO-LOCK WHERE SensorReading.PlotId = piPlotId USE-INDEX PlotReadAt:
        iAge = MAX(0, INTERVAL(ptAsOf, SensorReading.ReadAt, "minutes")).
        ASSIGN lHaveReading = TRUE dSoil = SensorReading.SoilMoisturePct lRaining = SensorReading.Raining.
        joFacts:Add("soilMoisturePct", SensorReading.SoilMoisturePct).
        joFacts:Add("temperatureC", SensorReading.TemperatureC).
        joFacts:Add("humidityPct", SensorReading.HumidityPct).
        joFacts:Add("raining", SensorReading.Raining).
        joFacts:Add("readingAt", fIso(SensorReading.ReadAt)).
        joFacts:Add("readingAgeMinutes", iAge).
        lHaveFresh = (iAge <= {&STALE_READING_MINUTES}).
    END.
    IF NOT lHaveReading THEN DO:
        joFacts:AddNull("soilMoisturePct").
        joFacts:AddNull("readingAgeMinutes").
    END.

    /* R2 action allowed (also blocks any chemical/dose style action) */
    IF LOOKUP(pcAction, {&ALLOWED_ACTIONS}) = 0 THEN
        RUN add-reason (jaReasons, "ACTION_NOT_ALLOWED",
            SUBSTITUTE("Action '&1' is not allowed. Allowed: irrigate, hold, notify.", pcAction)).

    IF lIrrigate THEN DO:
        /* R3 litres within plot limits */
        IF pdLitres < 1 OR pdLitres > Plot.MaxIrrigationLitres THEN
            RUN add-reason (jaReasons, "LITRES_OUT_OF_RANGE",
                SUBSTITUTE("Litres must be between 1 and &1 for this plot.", Plot.MaxIrrigationLitres)).
        /* R4 sensor data present and fresh */
        IF NOT lHaveReading THEN
            RUN add-reason (jaReasons, "NO_SENSOR_DATA", "No sensor reading exists for this plot.").
        ELSE IF NOT lHaveFresh THEN
            RUN add-reason (jaReasons, "SENSOR_STALE",
                SUBSTITUTE("Latest reading is &1 min old (limit &2).", iAge, {&STALE_READING_MINUTES})).
        /* R5 soil must be below the dry threshold, R6 no rain (only judged on fresh data) */
        IF lHaveFresh THEN DO:
            IF dSoil >= Plot.DryThresholdPct THEN
                RUN add-reason (jaReasons, "SOIL_NOT_DRY",
                    SUBSTITUTE("Soil moisture &1% is not below the dry threshold &2%.",
                               dSoil, Plot.DryThresholdPct)).
            IF lRaining THEN
                RUN add-reason (jaReasons, "RAIN_DETECTED", "Rain is being detected on this plot.").
        END.
        /* R7 weekly water budget */
        IF dUsed + pdLitres > Plot.WeeklyWaterBudgetL THEN
            RUN add-reason (jaReasons, "WATER_BUDGET_EXCEEDED",
                SUBSTITUTE("Used &1 L in the last 7 days; adding &2 L would exceed the weekly budget of &3 L.",
                           dUsed, pdLitres, Plot.WeeklyWaterBudgetL)).
    END.

    poResult:Add("verdict", (IF jaReasons:Length = 0 THEN "approved_by_rules" ELSE "rejected_by_rules")).
    poResult:Add("rejectReasons", jaReasons).
    poResult:Add("facts", joFacts).
END PROCEDURE.

PROCEDURE add-reason:
    DEFINE INPUT PARAMETER poArr  AS JsonArray NO-UNDO.
    DEFINE INPUT PARAMETER pcCode AS CHARACTER NO-UNDO.
    DEFINE INPUT PARAMETER pcMsg  AS CHARACTER NO-UNDO.
    DEFINE VARIABLE jo AS JsonObject NO-UNDO.
    jo = NEW JsonObject().
    jo:Add("code", pcCode).
    jo:Add("message", pcMsg).
    poArr:Add(jo).
END PROCEDURE.

/* ---------- route handlers ---------- */
PROCEDURE h-list-plots:
    DEFINE VARIABLE ja AS JsonArray NO-UNDO.
    DEFINE VARIABLE jo AS JsonObject NO-UNDO.
    ja = NEW JsonArray().
    FOR EACH Plot NO-LOCK BY Plot.PlotId:
        ja:Add(fPlotJson(Plot.PlotId)).
    END.
    jo = NEW JsonObject().
    jo:Add("plots", ja).
    RUN reply (200, jo).
END PROCEDURE.

PROCEDURE h-get-plot:
    DEFINE INPUT PARAMETER piId AS INTEGER NO-UNDO.
    DEFINE VARIABLE jo AS JsonObject NO-UNDO.
    jo = fPlotJson(piId).
    IF jo = ? THEN RUN reply-error (404, "PLOT_NOT_FOUND", SUBSTITUTE("No plot with id &1.", piId), ?).
    ELSE RUN reply (200, jo).
END PROCEDURE.

PROCEDURE h-readings:
    DEFINE INPUT PARAMETER piId AS INTEGER NO-UNDO.
    DEFINE VARIABLE ja AS JsonArray NO-UNDO.
    DEFINE VARIABLE jo AS JsonObject NO-UNDO.
    DEFINE VARIABLE jr AS JsonObject NO-UNDO.
    DEFINE VARIABLE iLimit AS INTEGER NO-UNDO INITIAL 20.
    DEFINE VARIABLE iCnt AS INTEGER NO-UNDO INITIAL 0.
    DEFINE VARIABLE cLim AS CHARACTER NO-UNDO.
    FIND Plot WHERE Plot.PlotId = piId NO-LOCK NO-ERROR.
    IF NOT AVAILABLE Plot THEN DO:
        RUN reply-error (404, "PLOT_NOT_FOUND", SUBSTITUTE("No plot with id &1.", piId), ?).
        RETURN.
    END.
    cLim = fQuery("limit").
    IF cLim <> ? THEN iLimit = INTEGER(cLim) NO-ERROR.
    IF iLimit < 1 OR iLimit > 500 THEN iLimit = 20.
    ja = NEW JsonArray().
    FOR EACH SensorReading NO-LOCK WHERE SensorReading.PlotId = piId USE-INDEX PlotReadAt:
        iCnt = iCnt + 1.
        IF iCnt > iLimit THEN LEAVE.
        jr = NEW JsonObject().
        jr:Add("readingId", SensorReading.ReadingId).
        jr:Add("deviceId", SensorReading.DeviceId).
        jr:Add("readAt", fIso(SensorReading.ReadAt)).
        jr:Add("soilMoisturePct", SensorReading.SoilMoisturePct).
        jr:Add("temperatureC", SensorReading.TemperatureC).
        jr:Add("humidityPct", SensorReading.HumidityPct).
        jr:Add("raining", SensorReading.Raining).
        ja:Add(jr).
    END.
    jo = NEW JsonObject().
    jo:Add("plotId", piId).
    jo:Add("readings", ja).
    RUN reply (200, jo).
END PROCEDURE.

PROCEDURE h-post-reading:
    DEFINE VARIABLE cDev AS CHARACTER NO-UNDO.
    DEFINE VARIABLE cTs  AS CHARACTER NO-UNDO.
    DEFINE VARIABLE dPlot AS DECIMAL NO-UNDO.
    DEFINE VARIABLE dSoil AS DECIMAL NO-UNDO.
    DEFINE VARIABLE dTemp AS DECIMAL NO-UNDO.
    DEFINE VARIABLE dHum  AS DECIMAL NO-UNDO.
    DEFINE VARIABLE lOk   AS LOGICAL NO-UNDO.
    DEFINE VARIABLE lRain AS LOGICAL NO-UNDO INITIAL FALSE.
    DEFINE VARIABLE tTs   AS DATETIME-TZ NO-UNDO.
    DEFINE VARIABLE jo    AS JsonObject NO-UNDO.

    RUN get-str (goBody, "deviceId", OUTPUT cDev, OUTPUT lOk).
    IF NOT lOk OR cDev = "" OR LENGTH(cDev) > 40 THEN DO:
        RUN reply-error (400, "VALIDATION_ERROR", "deviceId must be a string of 1 to 40 characters.", "deviceId"). RETURN.
    END.
    RUN get-num (goBody, "plotId", OUTPUT dPlot, OUTPUT lOk).
    IF NOT lOk OR dPlot <> TRUNCATE(dPlot, 0) THEN DO:
        RUN reply-error (400, "VALIDATION_ERROR", "plotId must be an integer.", "plotId"). RETURN.
    END.
    RUN get-str (goBody, "timestamp", OUTPUT cTs, OUTPUT lOk).
    IF lOk THEN tTs = fParseIso(cTs).
    IF NOT lOk OR tTs = ? THEN DO:
        RUN reply-error (400, "VALIDATION_ERROR", "timestamp must be ISO 8601 UTC, e.g. 2026-10-24T08:00:00Z.", "timestamp"). RETURN.
    END.
    RUN get-num (goBody, "soilMoisturePct", OUTPUT dSoil, OUTPUT lOk).
    IF NOT lOk OR dSoil < 0 OR dSoil > 100 THEN DO:
        RUN reply-error (400, "VALIDATION_ERROR", "soilMoisturePct must be a number between 0 and 100.", "soilMoisturePct"). RETURN.
    END.
    RUN get-num (goBody, "temperatureC", OUTPUT dTemp, OUTPUT lOk).
    IF NOT lOk OR dTemp < -20 OR dTemp > 60 THEN DO:
        RUN reply-error (400, "VALIDATION_ERROR", "temperatureC must be a number between -20 and 60.", "temperatureC"). RETURN.
    END.
    RUN get-num (goBody, "humidityPct", OUTPUT dHum, OUTPUT lOk).
    IF NOT lOk OR dHum < 0 OR dHum > 100 THEN DO:
        RUN reply-error (400, "VALIDATION_ERROR", "humidityPct must be a number between 0 and 100.", "humidityPct"). RETURN.
    END.
    IF goBody:Has("raining") THEN DO:
        IF goBody:GetType("raining") <> JsonDataType:BOOLEAN THEN DO:
            RUN reply-error (400, "VALIDATION_ERROR", "raining must be true or false.", "raining"). RETURN.
        END.
        lRain = goBody:GetLogical("raining").
    END.
    FIND Plot WHERE Plot.PlotId = INTEGER(dPlot) NO-LOCK NO-ERROR.
    IF NOT AVAILABLE Plot THEN DO:
        RUN reply-error (404, "PLOT_NOT_FOUND", SUBSTITUTE("No plot with id &1.", INTEGER(dPlot)), "plotId"). RETURN.
    END.
    FIND SensorReading WHERE SensorReading.DeviceId = cDev AND SensorReading.ReadAt = tTs NO-LOCK NO-ERROR.
    IF AVAILABLE SensorReading THEN DO:
        RUN reply-error (409, "DUPLICATE_READING", "A reading for this deviceId and timestamp already exists.", "timestamp"). RETURN.
    END.
    CREATE SensorReading.
    ASSIGN SensorReading.ReadingId       = NEXT-VALUE(ReadingSeq)
           SensorReading.PlotId          = INTEGER(dPlot)
           SensorReading.DeviceId        = cDev
           SensorReading.ReadAt          = tTs
           SensorReading.SoilMoisturePct = dSoil
           SensorReading.TemperatureC    = dTemp
           SensorReading.HumidityPct     = dHum
           SensorReading.Raining         = lRain.
    jo = NEW JsonObject().
    jo:Add("id", SensorReading.ReadingId).
    RELEASE SensorReading.
    RUN reply (201, jo).
END PROCEDURE.

PROCEDURE parse-validate-input:
    /* shared by POST /validate and POST /suggestions */
    DEFINE OUTPUT PARAMETER piPlotId AS INTEGER NO-UNDO.
    DEFINE OUTPUT PARAMETER pcAction AS CHARACTER NO-UNDO.
    DEFINE OUTPUT PARAMETER pdLitres AS DECIMAL NO-UNDO.
    DEFINE OUTPUT PARAMETER ptAsOf   AS DATETIME-TZ NO-UNDO.
    DEFINE OUTPUT PARAMETER plOk     AS LOGICAL NO-UNDO INITIAL FALSE.
    DEFINE VARIABLE dPlot AS DECIMAL NO-UNDO.
    DEFINE VARIABLE lOk AS LOGICAL NO-UNDO.
    DEFINE VARIABLE cAsOf AS CHARACTER NO-UNDO.
    RUN get-num (goBody, "plotId", OUTPUT dPlot, OUTPUT lOk).
    IF NOT lOk OR dPlot <> TRUNCATE(dPlot, 0) THEN DO:
        RUN reply-error (400, "VALIDATION_ERROR", "plotId must be an integer.", "plotId"). RETURN.
    END.
    piPlotId = INTEGER(dPlot).
    RUN get-str (goBody, "action", OUTPUT pcAction, OUTPUT lOk).
    IF NOT lOk THEN DO:
        RUN reply-error (400, "VALIDATION_ERROR", "action must be a string.", "action"). RETURN.
    END.
    pdLitres = 0.
    IF goBody:Has("litres") THEN DO:
        RUN get-num (goBody, "litres", OUTPUT pdLitres, OUTPUT lOk).
        IF NOT lOk THEN DO:
            RUN reply-error (400, "VALIDATION_ERROR", "litres must be a number.", "litres"). RETURN.
        END.
    END.
    ptAsOf = NOW.
    IF goBody:Has("asOf") THEN DO:
        RUN get-str (goBody, "asOf", OUTPUT cAsOf, OUTPUT lOk).
        IF lOk THEN ptAsOf = fParseIso(cAsOf).
        IF NOT lOk OR ptAsOf = ? THEN DO:
            RUN reply-error (400, "VALIDATION_ERROR", "asOf must be ISO 8601 UTC.", "asOf"). RETURN.
        END.
    END.
    plOk = TRUE.
END PROCEDURE.

PROCEDURE h-validate:
    DEFINE VARIABLE iPlot AS INTEGER NO-UNDO.
    DEFINE VARIABLE cAct AS CHARACTER NO-UNDO.
    DEFINE VARIABLE dLit AS DECIMAL NO-UNDO.
    DEFINE VARIABLE tAsOf AS DATETIME-TZ NO-UNDO.
    DEFINE VARIABLE lOk AS LOGICAL NO-UNDO.
    DEFINE VARIABLE jo AS JsonObject NO-UNDO.
    RUN parse-validate-input (OUTPUT iPlot, OUTPUT cAct, OUTPUT dLit, OUTPUT tAsOf, OUTPUT lOk).
    IF NOT lOk THEN RETURN.
    RUN do-validate (iPlot, cAct, dLit, tAsOf, OUTPUT jo).
    RUN reply (200, jo).
END PROCEDURE.

PROCEDURE h-create-suggestion:
    DEFINE VARIABLE iPlot AS INTEGER NO-UNDO.
    DEFINE VARIABLE cAct AS CHARACTER NO-UNDO.
    DEFINE VARIABLE dLit AS DECIMAL NO-UNDO.
    DEFINE VARIABLE tAsOf AS DATETIME-TZ NO-UNDO.
    DEFINE VARIABLE lOk AS LOGICAL NO-UNDO.
    DEFINE VARIABLE joV AS JsonObject NO-UNDO.
    DEFINE VARIABLE cReason AS CHARACTER NO-UNDO.
    DEFINE VARIABLE cProv AS CHARACTER NO-UNDO.
    DEFINE VARIABLE cReq AS CHARACTER NO-UNDO.
    DEFINE VARIABLE cJson AS LONGCHAR NO-UNDO.
    DEFINE VARIABLE iAud AS INTEGER NO-UNDO.
    DEFINE VARIABLE lApproved AS LOGICAL NO-UNDO.
    DEFINE VARIABLE iNew AS INTEGER NO-UNDO.
    RUN parse-validate-input (OUTPUT iPlot, OUTPUT cAct, OUTPUT dLit, OUTPUT tAsOf, OUTPUT lOk).
    IF NOT lOk THEN RETURN.
    RUN get-str (goBody, "reason", OUTPUT cReason, OUTPUT lOk). IF NOT lOk THEN cReason = "".
    RUN get-str (goBody, "provider", OUTPUT cProv, OUTPUT lOk). IF NOT lOk THEN cProv = "unknown".
    RUN get-str (goBody, "requestId", OUTPUT cReq, OUTPUT lOk). IF NOT lOk THEN cReq = "".
    FIND Plot WHERE Plot.PlotId = iPlot NO-LOCK NO-ERROR.
    IF NOT AVAILABLE Plot THEN DO:
        RUN reply-error (404, "PLOT_NOT_FOUND", SUBSTITUTE("No plot with id &1.", iPlot), "plotId"). RETURN.
    END.
    RUN do-validate (iPlot, cAct, dLit, tAsOf, OUTPUT joV).
    lApproved = (joV:GetCharacter("verdict") = "approved_by_rules").
    joV:GetJsonArray("rejectReasons"):Write(INPUT-OUTPUT cJson, FALSE).
    CREATE AiSuggestion.
    ASSIGN AiSuggestion.SuggestionId  = NEXT-VALUE(SuggestionSeq)
           AiSuggestion.PlotId        = iPlot
           AiSuggestion.CreatedAt     = tAsOf
           AiSuggestion.Action        = cAct
           AiSuggestion.Litres        = INTEGER(dLit)
           AiSuggestion.Reason        = SUBSTRING(cReason, 1, 1000)
           AiSuggestion.Provider      = cProv
           AiSuggestion.SuggStatus        = (IF lApproved THEN "pending_approval" ELSE "rejected")
           AiSuggestion.Verdict       = joV:GetCharacter("verdict")
           AiSuggestion.RejectReasons = SUBSTRING(STRING(cJson), 1, 2000)
           AiSuggestion.RequestId     = cReq.
    iNew = AiSuggestion.SuggestionId.
    RELEASE AiSuggestion.
    RUN audit (cReq, "abl-rules", "rule_check",
               SUBSTITUTE("suggestion &1 plot &2 &3 &4 L => &5", iNew, iPlot, cAct, INTEGER(dLit), joV:GetCharacter("verdict")),
               tAsOf, OUTPUT iAud).
    RUN reply (201, fSuggJson(iNew)).
END PROCEDURE.

PROCEDURE h-list-suggestions:
    DEFINE VARIABLE ja AS JsonArray NO-UNDO.
    DEFINE VARIABLE jo AS JsonObject NO-UNDO.
    DEFINE VARIABLE cStatus AS CHARACTER NO-UNDO.
    cStatus = fQuery("status").
    ja = NEW JsonArray().
    FOR EACH AiSuggestion NO-LOCK BY AiSuggestion.SuggestionId DESC:
        IF cStatus <> ? AND AiSuggestion.SuggStatus <> cStatus THEN NEXT.
        ja:Add(fSuggJson(AiSuggestion.SuggestionId)).
    END.
    jo = NEW JsonObject().
    jo:Add("suggestions", ja).
    RUN reply (200, jo).
END PROCEDURE.

PROCEDURE h-get-suggestion:
    DEFINE INPUT PARAMETER piId AS INTEGER NO-UNDO.
    DEFINE VARIABLE jo AS JsonObject NO-UNDO.
    jo = fSuggJson(piId).
    IF jo = ? THEN RUN reply-error (404, "SUGGESTION_NOT_FOUND", SUBSTITUTE("No suggestion with id &1.", piId), ?).
    ELSE RUN reply (200, jo).
END PROCEDURE.

PROCEDURE h-decision:
    DEFINE INPUT PARAMETER piId AS INTEGER NO-UNDO.
    DEFINE VARIABLE cDec AS CHARACTER NO-UNDO.
    DEFINE VARIABLE cActor AS CHARACTER NO-UNDO.
    DEFINE VARIABLE cReq AS CHARACTER NO-UNDO.
    DEFINE VARIABLE cAsOf AS CHARACTER NO-UNDO.
    DEFINE VARIABLE tAsOf AS DATETIME-TZ NO-UNDO.
    DEFINE VARIABLE lOk AS LOGICAL NO-UNDO.
    DEFINE VARIABLE joV AS JsonObject NO-UNDO.
    DEFINE VARIABLE jo AS JsonObject NO-UNDO.
    DEFINE VARIABLE cJson AS LONGCHAR NO-UNDO.
    DEFINE VARIABLE iAud AS INTEGER NO-UNDO.
    DEFINE VARIABLE cEvent AS CHARACTER NO-UNDO.
    DEFINE VARIABLE iSPlot AS INTEGER NO-UNDO.
    DEFINE VARIABLE cSAct AS CHARACTER NO-UNDO.
    DEFINE VARIABLE dSLit AS DECIMAL NO-UNDO.

    RUN get-str (goBody, "decision", OUTPUT cDec, OUTPUT lOk).
    IF NOT lOk OR LOOKUP(cDec, "approve,reject,delete") = 0 THEN DO:
        RUN reply-error (400, "VALIDATION_ERROR", "decision must be approve, reject or delete.", "decision"). RETURN.
    END.
    RUN get-str (goBody, "actor", OUTPUT cActor, OUTPUT lOk). IF NOT lOk THEN cActor = "farmer".
    RUN get-str (goBody, "requestId", OUTPUT cReq, OUTPUT lOk). IF NOT lOk THEN cReq = "".
    tAsOf = NOW.
    IF goBody:Has("asOf") THEN DO:
        RUN get-str (goBody, "asOf", OUTPUT cAsOf, OUTPUT lOk).
        IF lOk THEN tAsOf = fParseIso(cAsOf).
        IF NOT lOk OR tAsOf = ? THEN DO:
            RUN reply-error (400, "VALIDATION_ERROR", "asOf must be ISO 8601 UTC.", "asOf"). RETURN.
        END.
    END.
    /* read with NO-LOCK first (the rules read other AiSuggestion rows); take the exclusive lock only to write */
    FIND AiSuggestion WHERE AiSuggestion.SuggestionId = piId NO-LOCK NO-ERROR.
    IF NOT AVAILABLE AiSuggestion THEN DO:
        RUN reply-error (404, "SUGGESTION_NOT_FOUND", SUBSTITUTE("No suggestion with id &1.", piId), ?). RETURN.
    END.

    CASE cDec:
        WHEN "approve" THEN DO:
            IF AiSuggestion.SuggStatus = "rejected" THEN DO:
                RUN reply-error (409, "NOT_APPROVABLE", "This suggestion was rejected by the rules and cannot be approved.", ?). RETURN.
            END.
            IF AiSuggestion.SuggStatus <> "pending_approval" THEN DO:
                RUN reply-error (409, "ALREADY_DECIDED", SUBSTITUTE("Suggestion is already &1.", AiSuggestion.SuggStatus), ?). RETURN.
            END.
            /* re-run the rules now: the data may have changed since the proposal */
            ASSIGN iSPlot = AiSuggestion.PlotId cSAct = AiSuggestion.Action dSLit = AiSuggestion.Litres.
            RUN do-validate (iSPlot, cSAct, dSLit, tAsOf, OUTPUT joV).
            FIND CURRENT AiSuggestion EXCLUSIVE-LOCK NO-WAIT NO-ERROR.
            IF NOT AVAILABLE AiSuggestion THEN DO:
                RUN reply-error (409, "RECORD_LOCKED", "The suggestion is being changed by someone else. Try again.", ?). RETURN.
            END.
            IF joV:GetCharacter("verdict") <> "approved_by_rules" THEN DO:
                joV:GetJsonArray("rejectReasons"):Write(INPUT-OUTPUT cJson, FALSE).
                ASSIGN AiSuggestion.SuggStatus = "rejected"
                       AiSuggestion.Verdict = "rejected_by_rules"
                       AiSuggestion.RejectReasons = SUBSTRING(STRING(cJson), 1, 2000)
                       AiSuggestion.DecidedAt = tAsOf.
                RUN audit (cReq, cActor, "approve_blocked_by_rules", SUBSTITUTE("suggestion &1", piId), tAsOf, OUTPUT iAud).
                jo = fSuggJson(piId).
                jo:Add("error", "NOT_APPROVABLE").
                RUN reply (409, jo). RETURN.
            END.
            ASSIGN AiSuggestion.SuggStatus = "approved" AiSuggestion.DecidedAt = tAsOf.
            cEvent = "suggestion_approved".
        END.
        WHEN "reject" THEN DO:
            IF AiSuggestion.SuggStatus <> "pending_approval" THEN DO:
                RUN reply-error (409, "ALREADY_DECIDED", SUBSTITUTE("Suggestion is already &1.", AiSuggestion.SuggStatus), ?). RETURN.
            END.
            FIND CURRENT AiSuggestion EXCLUSIVE-LOCK NO-WAIT NO-ERROR.
            IF NOT AVAILABLE AiSuggestion THEN DO:
                RUN reply-error (409, "RECORD_LOCKED", "The suggestion is being changed by someone else. Try again.", ?). RETURN.
            END.
            ASSIGN AiSuggestion.SuggStatus = "declined" AiSuggestion.DecidedAt = tAsOf.
            cEvent = "suggestion_declined".
        END.
        WHEN "delete" THEN DO:
            IF AiSuggestion.SuggStatus = "approved" THEN DO:
                RUN reply-error (409, "CANNOT_DELETE_APPROVED", "Approved suggestions count against the water budget and cannot be deleted.", ?). RETURN.
            END.
            IF AiSuggestion.SuggStatus = "deleted" THEN DO:
                RUN reply-error (409, "ALREADY_DECIDED", "Suggestion is already deleted.", ?). RETURN.
            END.
            FIND CURRENT AiSuggestion EXCLUSIVE-LOCK NO-WAIT NO-ERROR.
            IF NOT AVAILABLE AiSuggestion THEN DO:
                RUN reply-error (409, "RECORD_LOCKED", "The suggestion is being changed by someone else. Try again.", ?). RETURN.
            END.
            ASSIGN AiSuggestion.SuggStatus = "deleted" AiSuggestion.DecidedAt = tAsOf.
            cEvent = "suggestion_deleted".
        END.
    END CASE.
    RELEASE AiSuggestion.
    RUN audit (cReq, cActor, cEvent, SUBSTITUTE("suggestion &1", piId), tAsOf, OUTPUT iAud).
    RUN reply (200, fSuggJson(piId)).
END PROCEDURE.

PROCEDURE h-post-audit:
    DEFINE VARIABLE cReq AS CHARACTER NO-UNDO.
    DEFINE VARIABLE cActor AS CHARACTER NO-UNDO.
    DEFINE VARIABLE cEvent AS CHARACTER NO-UNDO.
    DEFINE VARIABLE cDetail AS LONGCHAR NO-UNDO.
    DEFINE VARIABLE lOk AS LOGICAL NO-UNDO.
    DEFINE VARIABLE iId AS INTEGER NO-UNDO.
    DEFINE VARIABLE jo AS JsonObject NO-UNDO.
    RUN get-str (goBody, "event", OUTPUT cEvent, OUTPUT lOk).
    IF NOT lOk OR cEvent = "" THEN DO:
        RUN reply-error (400, "VALIDATION_ERROR", "event is required.", "event"). RETURN.
    END.
    RUN get-str (goBody, "requestId", OUTPUT cReq, OUTPUT lOk). IF NOT lOk THEN cReq = "".
    RUN get-str (goBody, "actor", OUTPUT cActor, OUTPUT lOk). IF NOT lOk THEN cActor = "api".
    IF goBody:Has("detail") THEN DO:
        IF goBody:GetType("detail") = JsonDataType:OBJECT THEN
            goBody:GetJsonObject("detail"):Write(INPUT-OUTPUT cDetail, FALSE).
        ELSE IF goBody:GetType("detail") = JsonDataType:STRING THEN cDetail = goBody:GetCharacter("detail").
    END.
    RUN audit (cReq, cActor, cEvent, STRING(cDetail), NOW, OUTPUT iId).
    jo = NEW JsonObject().
    jo:Add("id", iId).
    RUN reply (201, jo).
END PROCEDURE.

PROCEDURE h-list-audit:
    DEFINE VARIABLE ja AS JsonArray NO-UNDO.
    DEFINE VARIABLE jo AS JsonObject NO-UNDO.
    DEFINE VARIABLE je AS JsonObject NO-UNDO.
    DEFINE VARIABLE iLimit AS INTEGER NO-UNDO INITIAL 50.
    DEFINE VARIABLE iCnt AS INTEGER NO-UNDO INITIAL 0.
    DEFINE VARIABLE cLim AS CHARACTER NO-UNDO.
    cLim = fQuery("limit").
    IF cLim <> ? THEN iLimit = INTEGER(cLim) NO-ERROR.
    IF iLimit < 1 OR iLimit > 500 THEN iLimit = 50.
    ja = NEW JsonArray().
    FOR EACH AuditLog NO-LOCK BY AuditLog.AuditId DESC:
        iCnt = iCnt + 1.
        IF iCnt > iLimit THEN LEAVE.
        je = NEW JsonObject().
        je:Add("auditId", AuditLog.AuditId).
        je:Add("at", fIso(AuditLog.LoggedAt)).
        je:Add("requestId", AuditLog.RequestId).
        je:Add("actor", AuditLog.Actor).
        je:Add("event", AuditLog.Event).
        je:Add("detail", AuditLog.Detail).
        ja:Add(je).
    END.
    jo = NEW JsonObject().
    jo:Add("events", ja).
    RUN reply (200, jo).
END PROCEDURE.

/* ---------- dispatcher ---------- */
PROCEDURE dispatch:
    DEFINE VARIABLE cP AS CHARACTER NO-UNDO.
    DEFINE VARIABLE n  AS INTEGER NO-UNDO.
    DEFINE VARIABLE oParser AS ObjectModelParser NO-UNDO.
    DEFINE VARIABLE iId AS INTEGER NO-UNDO.
    DEFINE VARIABLE lBad AS LOGICAL NO-UNDO INITIAL FALSE.

    cP = pcPath.
    IF INDEX(cP, "?") > 0 THEN ASSIGN gcQuery = SUBSTRING(cP, INDEX(cP, "?") + 1)
                                      cP = SUBSTRING(cP, 1, INDEX(cP, "?") - 1).
    ELSE gcQuery = "".
    cP = TRIM(cP, "/").
    IF cP BEGINS "web/" THEN cP = SUBSTRING(cP, 5).
    IF cP = "farm" THEN cP = "".
    ELSE IF cP BEGINS "farm/" THEN cP = SUBSTRING(cP, 6).
    gcSegs = cP.
    n = NUM-ENTRIES(cP, "/").

    IF pcBody <> "" AND pcBody <> ? THEN DO ON ERROR UNDO, LEAVE:
        oParser = NEW ObjectModelParser().
        goBody = CAST(oParser:Parse(pcBody), JsonObject) NO-ERROR.
        IF ERROR-STATUS:ERROR THEN lBad = TRUE.
    END.
    IF lBad THEN DO:
        RUN reply-error (400, "INVALID_JSON", "Request body is not valid JSON.", ?). RETURN.
    END.
    IF goBody = ? THEN goBody = NEW JsonObject().

    CASE pcMethod:
        WHEN "GET" THEN DO:
            IF cP = "plots" THEN RUN h-list-plots.
            ELSE IF n = 2 AND ENTRY(1, cP, "/") = "plots" THEN RUN h-get-plot (INTEGER(ENTRY(2, cP, "/"))).
            ELSE IF n = 3 AND ENTRY(1, cP, "/") = "plots" AND ENTRY(3, cP, "/") = "readings"
                THEN RUN h-readings (INTEGER(ENTRY(2, cP, "/"))).
            ELSE IF cP = "suggestions" THEN RUN h-list-suggestions.
            ELSE IF n = 2 AND ENTRY(1, cP, "/") = "suggestions" THEN RUN h-get-suggestion (INTEGER(ENTRY(2, cP, "/"))).
            ELSE IF cP = "audit" THEN RUN h-list-audit.
            ELSE RUN reply-error (404, "NOT_FOUND", "Unknown route.", ?).
        END.
        WHEN "POST" THEN DO:
            IF cP = "readings" THEN RUN h-post-reading.
            ELSE IF cP = "validate" THEN RUN h-validate.
            ELSE IF cP = "suggestions" THEN RUN h-create-suggestion.
            ELSE IF n = 3 AND ENTRY(1, cP, "/") = "suggestions" AND ENTRY(3, cP, "/") = "decision"
                THEN RUN h-decision (INTEGER(ENTRY(2, cP, "/"))).
            ELSE IF cP = "audit" THEN RUN h-post-audit.
            ELSE RUN reply-error (404, "NOT_FOUND", "Unknown route.", ?).
        END.
        OTHERWISE RUN reply-error (405, "METHOD_NOT_ALLOWED", "Method not allowed.", ?).
    END CASE.
END PROCEDURE.

/* ---------- main ---------- */
DEFINE VARIABLE iMsg AS INTEGER NO-UNDO.
DEFINE VARIABLE cErrText AS CHARACTER NO-UNDO INITIAL "".
DO ON ERROR UNDO, LEAVE:
    RUN dispatch NO-ERROR.
    IF ERROR-STATUS:ERROR OR goResp = ? THEN DO:
        DO iMsg = 1 TO ERROR-STATUS:NUM-MESSAGES:
            cErrText = cErrText + (IF cErrText = "" THEN "" ELSE " | ") + ERROR-STATUS:GET-MESSAGE(iMsg).
        END.
        IF cErrText = "" THEN cErrText = "Unexpected error".
        goResp = NEW JsonObject().
        goResp:Add("error", "INTERNAL_ERROR").
        goResp:Add("message", cErrText).
        giStatus = 500.
    END.
END.
goResp:Write(INPUT-OUTPUT gcResp, FALSE).
ASSIGN pcResponse = gcResp
       piStatus   = giStatus.
