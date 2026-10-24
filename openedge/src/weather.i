/*------------------------------------------------------------------------
  weather.i - weather alerts from the 7-day forecast (feature 17), compiled
  as part of farm-api.p (included after market.i). Same behaviour as
  mock-pasoe/weather.js (docs/WEATHER.md). No AI: OpenEdge creates and words
  every alert from ForecastDay and AlertThreshold rows.
  The forecast in the seed is FICTIONAL EXAMPLE DATA (synthetic CSV).
  RULES: heat (TempMaxC >= value), heavy rain (RainMm >= value), frost
         (TempMinC <= value); the highest matching level wins per type and day;
         one alert per (farm, type, date) by unique index; alerts no longer
         implied by the forecast are expired on refresh;
         ALERT_THRESHOLD_INVALID on bad threshold edits.
------------------------------------------------------------------------*/

FUNCTION fWxRank RETURNS INTEGER (INPUT pc AS CHARACTER):
    RETURN LOOKUP(pc, "watch,warning,severe").
END FUNCTION.
FUNCTION fWx1 RETURNS CHARACTER (INPUT pd AS DECIMAL):
    RETURN TRIM(STRING(ROUND(pd, 1), "->>>>9.9")).
END FUNCTION.
FUNCTION fWxUnit RETURNS CHARACTER (INPUT pcType AS CHARACTER):
    RETURN (IF pcType = "rain" THEN "mm" ELSE "C").
END FUNCTION.
FUNCTION fWxMessage RETURNS CHARACTER (INPUT pcType AS CHARACTER, INPUT piDay AS INTEGER, INPUT pd AS DECIMAL):
    RETURN (IF pcType = "rain" THEN "Heavy rain" ELSE IF pcType = "heat" THEN "Heat" ELSE "Frost")
        + " Day " + STRING(piDay) + ", " + fWx1(pd) + " " + fWxUnit(pcType).
END FUNCTION.
FUNCTION fWxDate RETURNS CHARACTER (INPUT pd AS DATE):
    IF pd = ? THEN RETURN ?.
    RETURN ISO-DATE(pd).
END FUNCTION.
/* latest BaseDate for a province, or ? when it has no forecast */
FUNCTION fWxBase RETURNS DATE (INPUT pcProv AS CHARACTER):
    DEFINE BUFFER bF FOR ForecastDay.
    DEFINE VARIABLE d AS DATE NO-UNDO INITIAL ?.
    FOR EACH bF NO-LOCK WHERE bF.Province = pcProv:
        IF fEq(bF.Province, pcProv) AND (d = ? OR bF.BaseDate > d) THEN d = bF.BaseDate.
    END.
    RETURN d.
END FUNCTION.

FUNCTION fWxAlertJson RETURNS JsonObject (INPUT piId AS INTEGER):
    DEFINE BUFFER bA FOR WeatherAlert.
    DEFINE VARIABLE jo AS JsonObject NO-UNDO.
    FIND bA WHERE bA.AlertId = piId NO-LOCK NO-ERROR.
    IF NOT AVAILABLE bA THEN RETURN ?.
    jo = NEW JsonObject().
    jo:Add("alertId", bA.AlertId).
    jo:Add("farmId", bA.FarmId).
    jo:Add("province", bA.Province).
    jo:Add("alertType", bA.AlertType).
    jo:Add("dayNo", bA.DayNo).
    jo:Add("forecastDate", fWxDate(bA.ForecastDate)).
    jo:Add("value", bA.ObservedValue).
    jo:Add("unit", bA.Unit).
    jo:Add("level", bA.Level).
    jo:Add("message", bA.AlertText).
    jo:Add("status", bA.AlertStatus).
    jo:Add("createdAt", fIso(bA.CreatedAt)).
    IF bA.AckedAt = ? THEN jo:AddNull("ackedAt"). ELSE jo:Add("ackedAt", fIso(bA.AckedAt)).
    RETURN jo.
END FUNCTION.

FUNCTION fWxThJson RETURNS JsonObject (INPUT piId AS INTEGER):
    DEFINE BUFFER bT FOR AlertThreshold.
    DEFINE VARIABLE jo AS JsonObject NO-UNDO.
    FIND bT WHERE bT.ThresholdId = piId NO-LOCK NO-ERROR.
    IF NOT AVAILABLE bT THEN RETURN ?.
    jo = NEW JsonObject().
    jo:Add("thresholdId", bT.ThresholdId).
    jo:Add("alertType", bT.AlertType).
    jo:Add("op", bT.Op).
    jo:Add("value", bT.LimitValue).
    jo:Add("unit", bT.Unit).
    jo:Add("level", bT.Level).
    jo:Add("active", bT.Active).
    IF bT.UpdatedAt = ? THEN jo:AddNull("updatedAt"). ELSE jo:Add("updatedAt", fIso(bT.UpdatedAt)).
    jo:Add("updatedBy", bT.UpdatedBy).
    RETURN jo.
END FUNCTION.

/* open alerts of a farm, by date then type */
FUNCTION fWxOpenAlerts RETURNS JsonArray (INPUT piFarm AS INTEGER, INPUT pcStatus AS CHARACTER):
    DEFINE BUFFER bA FOR WeatherAlert.
    DEFINE VARIABLE ja AS JsonArray NO-UNDO.
    ja = NEW JsonArray().
    FOR EACH bA NO-LOCK WHERE bA.FarmId = piFarm BY bA.ForecastDate BY bA.AlertType:
        IF pcStatus <> ? AND pcStatus <> "" AND NOT fEq(bA.AlertStatus, pcStatus) THEN NEXT.
        ja:Add(fWxAlertJson(bA.AlertId)).
    END.
    RETURN ja.
END FUNCTION.

PROCEDURE h-wx-farm:
    DEFINE INPUT PARAMETER piId AS INTEGER NO-UNDO.
    DEFINE VARIABLE jo AS JsonObject NO-UNDO.
    DEFINE BUFFER bFm FOR Farm.
    FIND bFm WHERE bFm.FarmId = piId NO-LOCK NO-ERROR.
    IF piId = ? OR NOT AVAILABLE bFm THEN DO:
        RUN reply-error (404, "FARM_NOT_FOUND", SUBSTITUTE("No farm with id &1.", (IF piId = ? THEN "?" ELSE STRING(piId))), ?). RETURN.
    END.
    jo = NEW JsonObject().
    jo:Add("farmId", bFm.FarmId).
    jo:Add("farmName", bFm.FarmName).
    jo:Add("location", bFm.Location).
    jo:Add("province", bFm.Province).
    RUN reply (200, jo).
END PROCEDURE.

PROCEDURE h-wx-forecast:
    DEFINE VARIABLE cProv AS CHARACTER NO-UNDO.
    DEFINE VARIABLE dBase AS DATE NO-UNDO.
    DEFINE VARIABLE jo AS JsonObject NO-UNDO.
    DEFINE VARIABLE jd AS JsonObject NO-UNDO.
    DEFINE VARIABLE ja AS JsonArray NO-UNDO.
    DEFINE BUFFER bF FOR ForecastDay.
    cProv = fQuery("province").
    IF cProv = ? OR cProv = "" THEN DO: RUN reply-error (400, "VALIDATION_ERROR", "province is required.", "province"). RETURN. END.
    dBase = fWxBase(cProv).
    ja = NEW JsonArray().
    IF dBase <> ? THEN
        FOR EACH bF NO-LOCK WHERE bF.Province = cProv AND bF.BaseDate = dBase BY bF.DayNo:
            IF NOT fEq(bF.Province, cProv) THEN NEXT.
            jd = NEW JsonObject().
            jd:Add("dayNo", bF.DayNo).
            jd:Add("date", fWxDate(bF.ForecastDate)).
            jd:Add("tempMaxC", bF.TempMaxC).
            jd:Add("tempMinC", bF.TempMinC).
            jd:Add("rainMm", bF.RainMm).
            ja:Add(jd).
        END.
    jo = NEW JsonObject().
    jo:Add("province", cProv).
    IF dBase = ? THEN jo:AddNull("baseDate"). ELSE jo:Add("baseDate", fWxDate(dBase)).
    jo:Add("isSynthetic", TRUE).
    jo:Add("source", "example").
    jo:Add("noData", ja:Length = 0).
    jo:Add("days", ja).
    RUN reply (200, jo).
END PROCEDURE.

PROCEDURE h-wx-alerts:
    DEFINE VARIABLE cFarm AS CHARACTER NO-UNDO.
    DEFINE VARIABLE iFarm AS INTEGER NO-UNDO.
    DEFINE VARIABLE jo AS JsonObject NO-UNDO.
    cFarm = fQuery("farmId").
    iFarm = fPathId(cFarm).
    IF iFarm = ? THEN DO: RUN reply-error (400, "VALIDATION_ERROR", "farmId is required.", "farmId"). RETURN. END.
    jo = NEW JsonObject().
    jo:Add("alerts", fWxOpenAlerts(iFarm, fQuery("status"))).
    RUN reply (200, jo).
END PROCEDURE.

PROCEDURE h-wx-thresholds:
    DEFINE VARIABLE ja AS JsonArray NO-UNDO.
    DEFINE BUFFER bT FOR AlertThreshold.
    ja = NEW JsonArray().
    FOR EACH bT NO-LOCK BY bT.ThresholdId: ja:Add(fWxThJson(bT.ThresholdId)). END.
    RUN p-reply-named ("thresholds", ja).
END PROCEDURE.

/* POST /farm/alerts/refresh {farmId}: create the alerts the forecast implies, expire the ones it no longer implies */
PROCEDURE h-wx-refresh:
    DEFINE VARIABLE dFarm AS DECIMAL NO-UNDO.
    DEFINE VARIABLE lOk AS LOGICAL NO-UNDO.
    DEFINE VARIABLE cReq AS CHARACTER NO-UNDO.
    DEFINE VARIABLE dBase AS DATE NO-UNDO.
    DEFINE VARIABLE iCreated AS INTEGER NO-UNDO.
    DEFINE VARIABLE iExpired AS INTEGER NO-UNDO.
    DEFINE VARIABLE cType AS CHARACTER NO-UNDO.
    DEFINE VARIABLE k AS INTEGER NO-UNDO.
    DEFINE VARIABLE dVal AS DECIMAL NO-UNDO.
    DEFINE VARIABLE cLevel AS CHARACTER NO-UNDO.
    DEFINE VARIABLE cWant AS CHARACTER NO-UNDO.   /* "type|yyyy-mm-dd" keys the forecast implies */
    DEFINE VARIABLE iAud AS INTEGER NO-UNDO.
    DEFINE VARIABLE jo AS JsonObject NO-UNDO.
    DEFINE BUFFER bFm FOR Farm.
    DEFINE BUFFER bF FOR ForecastDay.
    DEFINE BUFFER bT FOR AlertThreshold.
    DEFINE BUFFER bA FOR WeatherAlert.
    RUN get-num (goBody, "farmId", OUTPUT dFarm, OUTPUT lOk).
    IF NOT lOk OR dFarm <> TRUNCATE(dFarm, 0) THEN DO: RUN reply-error (400, "VALIDATION_ERROR", "farmId must be an integer.", "farmId"). RETURN. END.
    FIND bFm WHERE bFm.FarmId = INTEGER(dFarm) NO-LOCK NO-ERROR.
    IF NOT AVAILABLE bFm THEN DO: RUN reply-error (404, "FARM_NOT_FOUND", SUBSTITUTE("No farm with id &1.", INTEGER(dFarm)), ?). RETURN. END.
    RUN get-str (goBody, "requestId", OUTPUT cReq, OUTPUT lOk). IF NOT lOk THEN cReq = "".
    dBase = fWxBase(bFm.Province).
    DO TRANSACTION:
        IF dBase <> ? THEN
        FOR EACH bF NO-LOCK WHERE bF.Province = bFm.Province AND bF.BaseDate = dBase BY bF.DayNo:
            DO k = 1 TO 3:
                cType = ENTRY(k, "rain,heat,frost").
                dVal = (IF k = 1 THEN bF.RainMm ELSE IF k = 2 THEN bF.TempMaxC ELSE bF.TempMinC).
                cLevel = "".
                FOR EACH bT NO-LOCK WHERE bT.AlertType = cType AND bT.Active:
                    IF ((bT.Op = ">=" AND dVal >= bT.LimitValue) OR (bT.Op = "<=" AND dVal <= bT.LimitValue))
                       AND fWxRank(bT.Level) > fWxRank(cLevel) THEN cLevel = bT.Level.
                END.
                IF cLevel = "" THEN NEXT.
                cWant = cWant + (IF cWant = "" THEN "" ELSE ",") + cType + "|" + ISO-DATE(bF.ForecastDate).
                FIND bA WHERE bA.FarmId = bFm.FarmId AND bA.AlertType = cType AND bA.ForecastDate = bF.ForecastDate EXCLUSIVE-LOCK NO-ERROR.
                IF AVAILABLE bA THEN DO:
                    IF bA.AlertStatus = "expired" THEN DO:
                        ASSIGN bA.AlertStatus = "open" bA.Level = cLevel bA.ObservedValue = dVal bA.AlertText = fWxMessage(cType, bF.DayNo, dVal) bA.AckedAt = ?.
                        iCreated = iCreated + 1.
                    END.
                    NEXT.
                END.
                CREATE bA.
                ASSIGN bA.AlertId = NEXT-VALUE(AlertSeq) bA.FarmId = bFm.FarmId bA.Province = bFm.Province bA.AlertType = cType
                       bA.DayNo = bF.DayNo bA.ForecastDate = bF.ForecastDate bA.ObservedValue = dVal bA.Unit = fWxUnit(cType) bA.Level = cLevel
                       bA.AlertText = fWxMessage(cType, bF.DayNo, dVal) bA.CreatedAt = NOW bA.AlertStatus = "open" bA.RequestId = cReq.
                iCreated = iCreated + 1.
            END.
        END.
        FOR EACH bA EXCLUSIVE-LOCK WHERE bA.FarmId = bFm.FarmId AND bA.AlertStatus = "open":
            IF LOOKUP(bA.AlertType + "|" + ISO-DATE(bA.ForecastDate), cWant) = 0 THEN ASSIGN bA.AlertStatus = "expired" iExpired = iExpired + 1.
        END.
    END.
    RUN audit (cReq, "abl-rules", "weather_alerts_refreshed",
        SUBSTITUTE('~{"farmId":&1,"province":"&2","noData":&3,"created":&4,"expired":&5}', bFm.FarmId, bFm.Province, (IF dBase = ? THEN "true" ELSE "false"), iCreated, iExpired), NOW, OUTPUT iAud).
    jo = NEW JsonObject().
    jo:Add("farmId", bFm.FarmId).
    jo:Add("province", bFm.Province).
    jo:Add("noData", dBase = ?).
    jo:Add("created", iCreated).
    jo:Add("expired", iExpired).
    jo:Add("alerts", fWxOpenAlerts(bFm.FarmId, "open")).
    RUN reply (200, jo).
END PROCEDURE.

PROCEDURE h-wx-ack:
    DEFINE INPUT PARAMETER piId AS INTEGER NO-UNDO.
    DEFINE VARIABLE cReq AS CHARACTER NO-UNDO.
    DEFINE VARIABLE cActor AS CHARACTER NO-UNDO.
    DEFINE VARIABLE lOk AS LOGICAL NO-UNDO.
    DEFINE VARIABLE iAud AS INTEGER NO-UNDO.
    DEFINE BUFFER bA FOR WeatherAlert.
    FIND bA WHERE bA.AlertId = piId EXCLUSIVE-LOCK NO-ERROR.
    IF piId = ? OR NOT AVAILABLE bA THEN DO:
        RUN reply-error (404, "ALERT_NOT_FOUND", SUBSTITUTE("No alert with id &1.", (IF piId = ? THEN "?" ELSE STRING(piId))), ?). RETURN.
    END.
    IF bA.AlertStatus <> "open" THEN DO:
        RUN reply-error (409, "ALREADY_DECIDED", SUBSTITUTE("Alert &1 is already &2.", bA.AlertId, bA.AlertStatus), ?). RETURN.
    END.
    RUN get-str (goBody, "requestId", OUTPUT cReq, OUTPUT lOk). IF NOT lOk THEN cReq = "".
    RUN get-str (goBody, "actor", OUTPUT cActor, OUTPUT lOk). IF NOT lOk THEN cActor = "farmer".
    ASSIGN bA.AlertStatus = "acknowledged" bA.AckedAt = NOW.
    RELEASE bA.
    RUN audit (cReq, cActor, "weather_alert_acknowledged", SUBSTITUTE('~{"alertId":&1}', piId), NOW, OUTPUT iAud).
    RUN reply (200, fWxAlertJson(piId)).
END PROCEDURE.

/* POST /farm/alert-thresholds/{id} {value?, level?, active?, updatedBy?} */
PROCEDURE h-wx-threshold-save:
    DEFINE INPUT PARAMETER piId AS INTEGER NO-UNDO.
    DEFINE VARIABLE dVal AS DECIMAL NO-UNDO.
    DEFINE VARIABLE cLevel AS CHARACTER NO-UNDO.
    DEFINE VARIABLE lActive AS LOGICAL NO-UNDO.
    DEFINE VARIABLE cBy AS CHARACTER NO-UNDO.
    DEFINE VARIABLE cReq AS CHARACTER NO-UNDO.
    DEFINE VARIABLE lOk AS LOGICAL NO-UNDO.
    DEFINE VARIABLE iAud AS INTEGER NO-UNDO.
    DEFINE BUFFER bT FOR AlertThreshold.
    DEFINE BUFFER bO FOR AlertThreshold.
    FIND bT WHERE bT.ThresholdId = piId NO-LOCK NO-ERROR.
    IF piId = ? OR NOT AVAILABLE bT THEN DO:
        RUN reply-error (404, "THRESHOLD_NOT_FOUND", SUBSTITUTE("No threshold with id &1.", (IF piId = ? THEN "?" ELSE STRING(piId))), ?). RETURN.
    END.
    ASSIGN dVal = bT.LimitValue cLevel = bT.Level lActive = bT.Active.
    IF goBody:Has("value") THEN DO:
        RUN get-num (goBody, "value", OUTPUT dVal, OUTPUT lOk).
        IF NOT lOk OR dVal * 10 <> TRUNCATE(dVal * 10, 0) THEN DO:
            RUN reply-error (400, "ALERT_THRESHOLD_INVALID", "value must be a number with at most one decimal.", "value"). RETURN.
        END.
    END.
    IF goBody:Has("level") THEN DO:
        RUN get-str (goBody, "level", OUTPUT cLevel, OUTPUT lOk).
        IF NOT lOk OR fWxRank(cLevel) = 0 OR NOT (fEq(cLevel, "watch") OR fEq(cLevel, "warning") OR fEq(cLevel, "severe")) THEN DO:
            RUN reply-error (400, "ALERT_THRESHOLD_INVALID", "level must be watch, warning or severe.", "level"). RETURN.
        END.
    END.
    IF goBody:Has("active") THEN DO:
        IF goBody:GetType("active") <> JsonDataType:BOOLEAN THEN DO:
            RUN reply-error (400, "ALERT_THRESHOLD_INVALID", "active must be true or false.", "active"). RETURN.
        END.
        lActive = goBody:GetLogical("active").
    END.
    IF bT.AlertType = "rain" AND NOT (dVal > 0 AND dVal <= 500) THEN DO:
        RUN reply-error (400, "ALERT_THRESHOLD_INVALID", "Rain threshold must be above 0 and at most 500 mm.", "value"). RETURN. END.
    IF bT.AlertType = "heat" AND NOT (dVal >= 0 AND dVal <= 60) THEN DO:
        RUN reply-error (400, "ALERT_THRESHOLD_INVALID", "Heat threshold must be between 0 and 60 C.", "value"). RETURN. END.
    IF bT.AlertType = "frost" AND NOT (dVal >= -20 AND dVal <= 20) THEN DO:
        RUN reply-error (400, "ALERT_THRESHOLD_INVALID", "Frost threshold must be between -20 and 20 C.", "value"). RETURN. END.
    IF lActive AND bT.AlertType = "frost" AND CAN-FIND(FIRST bO WHERE bO.AlertType = "heat" AND bO.Active AND bO.ThresholdId <> piId AND dVal >= bO.LimitValue) THEN DO:
        RUN reply-error (400, "ALERT_THRESHOLD_INVALID", "The frost (minimum) threshold must be below the heat (maximum) threshold.", "value"). RETURN. END.
    IF lActive AND bT.AlertType = "heat" AND CAN-FIND(FIRST bO WHERE bO.AlertType = "frost" AND bO.Active AND bO.ThresholdId <> piId AND dVal <= bO.LimitValue) THEN DO:
        RUN reply-error (400, "ALERT_THRESHOLD_INVALID", "The heat (maximum) threshold must be above the frost (minimum) threshold.", "value"). RETURN. END.
    RUN get-str (goBody, "updatedBy", OUTPUT cBy, OUTPUT lOk). IF NOT lOk THEN cBy = "api".
    RUN get-str (goBody, "requestId", OUTPUT cReq, OUTPUT lOk). IF NOT lOk THEN cReq = "".
    DO TRANSACTION:
        FIND bT WHERE bT.ThresholdId = piId EXCLUSIVE-LOCK.
        ASSIGN bT.LimitValue = dVal bT.Level = cLevel bT.Active = lActive bT.UpdatedAt = NOW bT.UpdatedBy = SUBSTRING(cBy, 1, 40).
        RELEASE bT.
    END.
    RUN audit (cReq, SUBSTRING(cBy, 1, 40), "alert_threshold_changed",
        SUBSTITUTE('~{"thresholdId":&1,"value":&2,"level":"&3","active":&4}', piId, fWx1(dVal), cLevel, (IF lActive THEN "true" ELSE "false")), NOW, OUTPUT iAud).
    RUN reply (200, fWxThJson(piId)).
END PROCEDURE.
