/* seed.p - (re)load FICTIONAL EXAMPLE DATA into the farm database.
   Idempotent: deletes farm-ops and co-op rows and the seeded Farm ids, resets sequences.
   Usage: _progres -b -db farm ... -p seed.p -param "C:\path\to\seed.json|C:\path\to\coop-seed.json"
   If the coop file is omitted, coop-seed.json is read from the same directory as seed.json.
   Schema 003-coop.df must already be loaded. */
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
DEFINE VARIABLE iMembers AS INTEGER NO-UNDO. DEFINE VARIABLE iCredits AS INTEGER NO-UNDO.
DEFINE VARIABLE iLots AS INTEGER NO-UNDO. DEFINE VARIABLE iContracts AS INTEGER NO-UNDO.
DEFINE VARIABLE cArgs AS CHARACTER NO-UNDO.
DEFINE VARIABLE cCoop AS CHARACTER NO-UNDO.
DEFINE VARIABLE joCoop AS JsonObject NO-UNDO.
DEFINE VARIABLE jaC AS JsonArray NO-UNDO.
DEFINE VARIABLE iKg AS INTEGER NO-UNDO.
DEFINE VARIABLE iSlash AS INTEGER NO-UNDO.
DEFINE VARIABLE iC AS INTEGER NO-UNDO.
DEFINE VARIABLE joC AS JsonObject NO-UNDO.

cArgs = SESSION:PARAMETER.
cFile = ENTRY(1, cArgs, "|").
IF NUM-ENTRIES(cArgs, "|") >= 2 THEN cCoop = ENTRY(2, cArgs, "|").
ELSE DO:
    iSlash = MAXIMUM(R-INDEX(cFile, "\"), R-INDEX(cFile, "/")).
    IF iSlash = 0 THEN cCoop = "coop-seed.json".
    ELSE cCoop = SUBSTRING(cFile, 1, iSlash) + "coop-seed.json".
END.
FILE-INFO:FILE-NAME = cCoop.
IF FILE-INFO:FULL-PATHNAME = ? THEN DO:
    MESSAGE "COOP SEED FILE NOT FOUND:" cCoop.
    RETURN ERROR.
END.
oParser = NEW ObjectModelParser().
joSeed = CAST(oParser:ParseFile(cFile), JsonObject).
oParser = NEW ObjectModelParser().
joCoop = CAST(oParser:ParseFile(cCoop), JsonObject).

DO TRANSACTION:
    FOR EACH Payout EXCLUSIVE-LOCK: DELETE Payout. END.
    FOR EACH Allocation EXCLUSIVE-LOCK: DELETE Allocation. END.
    FOR EACH LotContribution EXCLUSIVE-LOCK: DELETE LotContribution. END.
    FOR EACH InputCredit EXCLUSIVE-LOCK: DELETE InputCredit. END.
    FOR EACH HarvestLot EXCLUSIVE-LOCK: DELETE HarvestLot. END.
    FOR EACH BuyerContract EXCLUSIVE-LOCK: DELETE BuyerContract. END.
    FOR EACH CoopMember EXCLUSIVE-LOCK: DELETE CoopMember. END.
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
    CURRENT-VALUE(MemberSeq) = 0.
    CURRENT-VALUE(CreditSeq) = 0.
    CURRENT-VALUE(LotSeq) = 0.
    CURRENT-VALUE(ContractSeq) = 0.
    CURRENT-VALUE(AllocationSeq) = 0.
    CURRENT-VALUE(PayoutSeq) = 0.
    ja = joCoop:GetJsonArray("members").
    DO i = 1 TO ja:Length:
        jo = ja:GetJsonObject(i).
        CREATE CoopMember.
        ASSIGN CoopMember.MemberId = NEXT-VALUE(MemberSeq)
               CoopMember.MemberName = jo:GetCharacter("memberName")
               CoopMember.Location = jo:GetCharacter("location")
               CoopMember.PreferredLang = jo:GetCharacter("preferredLang")
               CoopMember.CreditLimit = jo:GetDecimal("creditLimit")
               CoopMember.IsExample = TRUE.
        iMembers = iMembers + 1.
    END.
    ja = joCoop:GetJsonArray("credits").
    DO i = 1 TO ja:Length:
        jo = ja:GetJsonObject(i).
        CREATE InputCredit.
        ASSIGN InputCredit.CreditId = NEXT-VALUE(CreditSeq)
               InputCredit.MemberId = jo:GetInteger("memberId")
               InputCredit.ItemName = jo:GetCharacter("item")
               InputCredit.Amount = jo:GetDecimal("amount")
               InputCredit.RepaidAmount = jo:GetDecimal("repaidAmount")
               InputCredit.CreditStatus = jo:GetCharacter("status")
               InputCredit.Verdict = "approved_by_rules"
               InputCredit.RejectReasons = "[]"
               InputCredit.CreatedAt = fParseIso(jo:GetCharacter("createdAt"))
               InputCredit.DecidedAt = fParseIso(jo:GetCharacter("decidedAt"))
               InputCredit.RequestId = "seed".
        iCredits = iCredits + 1.
    END.
    ja = joCoop:GetJsonArray("lots").
    DO i = 1 TO ja:Length:
        jo = ja:GetJsonObject(i).
        jaC = jo:GetJsonArray("contributions").
        iKg = 0.
        CREATE HarvestLot.
        ASSIGN HarvestLot.LotId = NEXT-VALUE(LotSeq)
               HarvestLot.LotCode = jo:GetCharacter("lotCode")
               HarvestLot.Crop = jo:GetCharacter("crop")
               HarvestLot.IsExample = TRUE.
        DO iC = 1 TO jaC:Length:
            joC = jaC:GetJsonObject(iC).
            CREATE LotContribution.
            ASSIGN LotContribution.LotId = HarvestLot.LotId
                   LotContribution.MemberId = joC:GetInteger("memberId")
                   LotContribution.Kg = joC:GetInteger("kg").
            iKg = iKg + LotContribution.Kg.
            RELEASE LotContribution.
        END.
        HarvestLot.QuantityKg = iKg.
        RELEASE HarvestLot.
        iLots = iLots + 1.
    END.
    ja = joCoop:GetJsonArray("contracts").
    DO i = 1 TO ja:Length:
        jo = ja:GetJsonObject(i).
        CREATE BuyerContract.
        ASSIGN BuyerContract.ContractId = NEXT-VALUE(ContractSeq)
               BuyerContract.ContractCode = jo:GetCharacter("contractCode")
               BuyerContract.BuyerName = jo:GetCharacter("buyerName")
               BuyerContract.Crop = jo:GetCharacter("crop")
               BuyerContract.QuantityKg = jo:GetInteger("quantityKg")
               BuyerContract.PricePerKg = jo:GetDecimal("pricePerKg")
               BuyerContract.ContractStatus = jo:GetCharacter("status")
               BuyerContract.IsExample = TRUE.
        iContracts = iContracts + 1.
    END.
END.
MESSAGE SUBSTITUTE("SEED OK: &1 farm(s), &2 plots, &3 readings, &4 suggestions, &5 members, &6 credits, &7 lots, &8 contracts (EXAMPLE DATA)", iFarms, iPlots, iReads, iSugg, iMembers, iCredits, iLots, iContracts).
