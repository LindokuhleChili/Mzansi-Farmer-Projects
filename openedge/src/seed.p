/* seed.p - (re)load FICTIONAL EXAMPLE DATA from openedge/data/seed.json into the farm database.
   Idempotent: deletes Plot/SensorReading/AiSuggestion/AuditLog rows and the seeded Farm ids, resets sequences.
   Usage: _progres -b -db farm ... -p seed.p -param "C:\path\to\seed.json" */
USING Progress.Json.ObjectModel.JsonObject.
USING Progress.Json.ObjectModel.JsonArray.
USING Progress.Json.ObjectModel.ObjectModelParser.
{iso.i}

DEFINE VARIABLE oParser AS ObjectModelParser NO-UNDO.
DEFINE VARIABLE joSeed  AS JsonObject NO-UNDO.
DEFINE VARIABLE ja      AS JsonArray  NO-UNDO.
DEFINE VARIABLE jo      AS JsonObject NO-UNDO.
DEFINE VARIABLE i       AS INTEGER    NO-UNDO.
DEFINE VARIABLE cFile   AS CHARACTER  NO-UNDO.
DEFINE VARIABLE iFarms AS INTEGER NO-UNDO. DEFINE VARIABLE iPlots AS INTEGER NO-UNDO.
DEFINE VARIABLE iReads AS INTEGER NO-UNDO. DEFINE VARIABLE iSugg AS INTEGER NO-UNDO.

cFile = SESSION:PARAMETER.
oParser = NEW ObjectModelParser().
joSeed = CAST(oParser:ParseFile(cFile), JsonObject).

DO TRANSACTION:
    FOR EACH AuditLog EXCLUSIVE-LOCK: DELETE AuditLog. END.
    FOR EACH AiSuggestion EXCLUSIVE-LOCK: DELETE AiSuggestion. END.
    FOR EACH SensorReading EXCLUSIVE-LOCK: DELETE SensorReading. END.
    FOR EACH Plot EXCLUSIVE-LOCK: DELETE Plot. END.
    ja = joSeed:GetJsonArray("farms").
    DO i = 1 TO ja:Length:
        jo = ja:GetJsonObject(i).
        FOR EACH Farm EXCLUSIVE-LOCK WHERE Farm.FarmId = jo:GetInteger("farmId"): DELETE Farm. END.
        CREATE Farm.
        ASSIGN Farm.FarmId = jo:GetInteger("farmId") Farm.FarmName = jo:GetCharacter("farmName")
               Farm.Location = jo:GetCharacter("location") Farm.Acreage = jo:GetDecimal("acreage").
        iFarms = iFarms + 1.
    END.
    ja = joSeed:GetJsonArray("plots").
    DO i = 1 TO ja:Length:
        jo = ja:GetJsonObject(i).
        CREATE Plot.
        ASSIGN Plot.PlotId = jo:GetInteger("plotId") Plot.FarmId = jo:GetInteger("farmId")
               Plot.PlotName = jo:GetCharacter("plotName") Plot.Crop = jo:GetCharacter("crop")
               Plot.AreaHa = jo:GetDecimal("areaHa") Plot.MaxIrrigationLitres = jo:GetInteger("maxIrrigationLitres")
               Plot.DryThresholdPct = jo:GetDecimal("dryThresholdPct")
               Plot.WeeklyWaterBudgetL = jo:GetInteger("weeklyWaterBudgetL") Plot.IsExample = TRUE.
        iPlots = iPlots + 1.
    END.
    CURRENT-VALUE(ReadingSeq) = 1000.
    CURRENT-VALUE(SuggestionSeq) = 0.
    CURRENT-VALUE(AuditSeq) = 0.
    ja = joSeed:GetJsonArray("readings").
    DO i = 1 TO ja:Length:
        jo = ja:GetJsonObject(i).
        CREATE SensorReading.
        ASSIGN SensorReading.ReadingId = NEXT-VALUE(ReadingSeq) SensorReading.PlotId = jo:GetInteger("plotId")
               SensorReading.DeviceId = jo:GetCharacter("deviceId")
               SensorReading.ReadAt = fParseIso(jo:GetCharacter("timestamp"))
               SensorReading.SoilMoisturePct = jo:GetDecimal("soilMoisturePct")
               SensorReading.TemperatureC = jo:GetDecimal("temperatureC")
               SensorReading.HumidityPct = jo:GetDecimal("humidityPct")
               SensorReading.Raining = jo:GetLogical("raining").
        iReads = iReads + 1.
    END.
    ja = joSeed:GetJsonArray("suggestions").
    DO i = 1 TO ja:Length:
        jo = ja:GetJsonObject(i).
        CREATE AiSuggestion.
        ASSIGN AiSuggestion.SuggestionId = NEXT-VALUE(SuggestionSeq) AiSuggestion.PlotId = jo:GetInteger("plotId")
               AiSuggestion.CreatedAt = fParseIso(jo:GetCharacter("createdAt"))
               AiSuggestion.DecidedAt = fParseIso(jo:GetCharacter("decidedAt"))
               AiSuggestion.Action = jo:GetCharacter("action") AiSuggestion.Litres = jo:GetInteger("litres")
               AiSuggestion.Reason = jo:GetCharacter("reason") AiSuggestion.Provider = jo:GetCharacter("provider")
               AiSuggestion.SuggStatus = jo:GetCharacter("status") AiSuggestion.Verdict = jo:GetCharacter("verdict")
               AiSuggestion.RejectReasons = "[]" AiSuggestion.RequestId = "seed".
        iSugg = iSugg + 1.
    END.
END.
MESSAGE SUBSTITUTE("SEED OK: &1 farm(s), &2 plots, &3 readings, &4 suggestions (EXAMPLE DATA)", iFarms, iPlots, iReads, iSugg).
