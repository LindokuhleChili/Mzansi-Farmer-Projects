/* seed.p - (re)load FICTIONAL EXAMPLE DATA into the farm database.
   Idempotent: deletes farm-ops, co-op and market rows and the seeded Farm ids, resets sequences.
   Usage: _progres -b -db farm ... -p seed.p -param "C:\path\to\seed.json|C:\path\to\coop-seed.json|C:\path\to\market-seed.json"
   If the coop or market file is omitted, coop-seed.json / market-seed.json is read from the same directory as seed.json.
   Schemas 003-coop.df and 004-market.df must already be loaded. */
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
DEFINE VARIABLE cMarket AS CHARACTER NO-UNDO.
DEFINE VARIABLE joMarket AS JsonObject NO-UNDO.
DEFINE VARIABLE iEvents AS INTEGER NO-UNDO. DEFINE VARIABLE iItems AS INTEGER NO-UNDO.
DEFINE VARIABLE iPrices AS INTEGER NO-UNDO. DEFINE VARIABLE iRes AS INTEGER NO-UNDO.
DEFINE VARIABLE iEvIdx AS INTEGER NO-UNDO. DEFINE VARIABLE iItIdx AS INTEGER NO-UNDO.
DEFINE BUFFER bMI FOR MarketItem.
/* weather alerts (feature 17): 4th file, default weather-seed.json next to seed.json */
DEFINE VARIABLE cWeather AS CHARACTER NO-UNDO.
DEFINE VARIABLE joWx AS JsonObject NO-UNDO.
DEFINE VARIABLE dWxBase AS DATE NO-UNDO.
/* plant doctor (feature 1/2): 5th file, default doctor-seed.json next to seed.json */
DEFINE VARIABLE cDoctor AS CHARACTER NO-UNDO.
DEFINE VARIABLE joDr AS JsonObject NO-UNDO.
DEFINE VARIABLE iDrTerms AS INTEGER NO-UNDO.
DEFINE VARIABLE iWxDays AS INTEGER NO-UNDO. DEFINE VARIABLE iWxTh AS INTEGER NO-UNDO.

cArgs = SESSION:PARAMETER.
cFile = ENTRY(1, cArgs, "|").
IF NUM-ENTRIES(cArgs, "|") >= 2 THEN cCoop = ENTRY(2, cArgs, "|").
ELSE DO:
    iSlash = MAXIMUM(R-INDEX(cFile, "\"), R-INDEX(cFile, "/")).
    IF iSlash = 0 THEN cCoop = "coop-seed.json".
    ELSE cCoop = SUBSTRING(cFile, 1, iSlash) + "coop-seed.json".
END.
IF NUM-ENTRIES(cArgs, "|") >= 3 THEN cMarket = ENTRY(3, cArgs, "|").
ELSE DO:
    iSlash = MAXIMUM(R-INDEX(cFile, "\"), R-INDEX(cFile, "/")).
    IF iSlash = 0 THEN cMarket = "market-seed.json".
    ELSE cMarket = SUBSTRING(cFile, 1, iSlash) + "market-seed.json".
END.
IF NUM-ENTRIES(cArgs, "|") >= 4 THEN cWeather = ENTRY(4, cArgs, "|").
ELSE DO:
    iSlash = MAXIMUM(R-INDEX(cFile, "\"), R-INDEX(cFile, "/")).
    IF iSlash = 0 THEN cWeather = "weather-seed.json".
    ELSE cWeather = SUBSTRING(cFile, 1, iSlash) + "weather-seed.json".
END.
IF NUM-ENTRIES(cArgs, "|") >= 5 THEN cDoctor = ENTRY(5, cArgs, "|").
ELSE DO:
    iSlash = MAXIMUM(R-INDEX(cFile, "\"), R-INDEX(cFile, "/")).
    IF iSlash = 0 THEN cDoctor = "doctor-seed.json".
    ELSE cDoctor = SUBSTRING(cFile, 1, iSlash) + "doctor-seed.json".
END.
FILE-INFO:FILE-NAME = cDoctor.
IF FILE-INFO:FULL-PATHNAME = ? THEN DO:
    MESSAGE "DOCTOR SEED FILE NOT FOUND:" cDoctor.
    RETURN ERROR.
END.
FILE-INFO:FILE-NAME = cWeather.
IF FILE-INFO:FULL-PATHNAME = ? THEN DO:
    MESSAGE "WEATHER SEED FILE NOT FOUND:" cWeather.
    RETURN ERROR.
END.
FILE-INFO:FILE-NAME = cMarket.
IF FILE-INFO:FULL-PATHNAME = ? THEN DO:
    MESSAGE "MARKET SEED FILE NOT FOUND:" cMarket.
    RETURN ERROR.
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
oParser = NEW ObjectModelParser().
joMarket = CAST(oParser:ParseFile(cMarket), JsonObject).
oParser = NEW ObjectModelParser().
joWx = CAST(oParser:ParseFile(cWeather), JsonObject).
oParser = NEW ObjectModelParser().
joDr = CAST(oParser:ParseFile(cDoctor), JsonObject).

DO TRANSACTION:
    FOR EACH Diagnosis EXCLUSIVE-LOCK: DELETE Diagnosis. END.
    FOR EACH BlockedTerm EXCLUSIVE-LOCK: DELETE BlockedTerm. END.
    FOR EACH WeatherAlert EXCLUSIVE-LOCK: DELETE WeatherAlert. END.
    FOR EACH AlertThreshold EXCLUSIVE-LOCK: DELETE AlertThreshold. END.
    FOR EACH ForecastDay EXCLUSIVE-LOCK: DELETE ForecastDay. END.
    FOR EACH MarketReservation EXCLUSIVE-LOCK: DELETE MarketReservation. END.
    FOR EACH MarketItem EXCLUSIVE-LOCK: DELETE MarketItem. END.
    FOR EACH MarketEvent EXCLUSIVE-LOCK: DELETE MarketEvent. END.
    FOR EACH RetailBuyerPrice EXCLUSIVE-LOCK: DELETE RetailBuyerPrice. END.
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
    /* harvest-day market (004-market.df) */
    CURRENT-VALUE(MarketEventSeq) = 0.
    CURRENT-VALUE(MarketItemSeq) = 0.
    CURRENT-VALUE(ReservationSeq) = 0.
    ja = joMarket:GetJsonArray("retailPrices").
    DO i = 1 TO ja:Length:
        jo = ja:GetJsonObject(i).
        CREATE RetailBuyerPrice.
        ASSIGN RetailBuyerPrice.Crop = jo:GetCharacter("crop")
               RetailBuyerPrice.PricePerKg = jo:GetDecimal("pricePerKg")
               RetailBuyerPrice.PriceSource = jo:GetCharacter("source")
               RetailBuyerPrice.IsExample = TRUE.
        RELEASE RetailBuyerPrice.
        iPrices = iPrices + 1.
    END.
    ja = joMarket:GetJsonArray("events").
    DO i = 1 TO ja:Length:
        jo = ja:GetJsonObject(i).
        CREATE MarketEvent.
        ASSIGN MarketEvent.EventId = NEXT-VALUE(MarketEventSeq)
               MarketEvent.FarmId = 1
               MarketEvent.EventName = jo:GetCharacter("eventName")
               MarketEvent.VenueName = jo:GetCharacter("venue")
               MarketEvent.VenueArea = jo:GetCharacter("area")
               MarketEvent.EventNotes = jo:GetCharacter("notes")
               MarketEvent.StartsAt = fParseIso(jo:GetCharacter("startsAt"))
               MarketEvent.EndsAt = fParseIso(jo:GetCharacter("endsAt"))
               MarketEvent.EventStatus = jo:GetCharacter("status")
               MarketEvent.Verdict = "approved_by_rules"
               MarketEvent.RejectReasons = "[]"
               MarketEvent.CreatedAt = fParseIso(jo:GetCharacter("createdAt"))
               MarketEvent.DecidedAt = fParseIso(jo:GetCharacter("decidedAt"))
               MarketEvent.RequestId = "seed"
               MarketEvent.IsExample = TRUE.
        jaC = jo:GetJsonArray("items").
        DO iC = 1 TO jaC:Length:
            joC = jaC:GetJsonObject(iC).
            CREATE MarketItem.
            ASSIGN MarketItem.ItemId = NEXT-VALUE(MarketItemSeq)
                   MarketItem.EventId = MarketEvent.EventId
                   MarketItem.ItemOrder = iC
                   MarketItem.Crop = joC:GetCharacter("crop")
                   MarketItem.ItemLabel = joC:GetCharacter("label")
                   MarketItem.QuantityKg = joC:GetInteger("quantityKg")
                   MarketItem.PricePerKg = joC:GetDecimal("pricePerKg")
                   MarketItem.LotId = (IF joC:Has("lotId") THEN joC:GetInteger("lotId") ELSE 0).
            RELEASE MarketItem.
            iItems = iItems + 1.
        END.
        RELEASE MarketEvent.
        iEvents = iEvents + 1.
    END.
    ja = joMarket:GetJsonArray("reservations").
    DO i = 1 TO ja:Length:
        jo = ja:GetJsonObject(i).
        iEvIdx = jo:GetInteger("eventIndex").
        iItIdx = jo:GetInteger("itemIndex").
        FIND bMI WHERE bMI.EventId = iEvIdx AND bMI.ItemOrder = iItIdx NO-LOCK.
        CREATE MarketReservation.
        ASSIGN MarketReservation.ReservationId = NEXT-VALUE(ReservationSeq)
               MarketReservation.EventId = bMI.EventId
               MarketReservation.ItemId = bMI.ItemId
               MarketReservation.BuyerName = jo:GetCharacter("buyerName")
               MarketReservation.QuantityKg = jo:GetInteger("quantityKg")
               MarketReservation.ResStatus = "confirmed"
               MarketReservation.Verdict = "approved_by_rules"
               MarketReservation.RejectReasons = "[]"
               MarketReservation.CreatedAt = fParseIso(jo:GetCharacter("createdAt"))
               MarketReservation.RequestId = "seed"
               MarketReservation.IsExample = TRUE.
        RELEASE MarketReservation.
        iRes = iRes + 1.
    END.
    /* ---- weather (feature 17): farm provinces, an extra example farm, thresholds, the synthetic 7-day forecast */
    CURRENT-VALUE(ForecastSeq) = 0. CURRENT-VALUE(ThresholdSeq) = 0. CURRENT-VALUE(AlertSeq) = 0.
    dWxBase = DATE(INTEGER(SUBSTRING(joWx:GetCharacter("baseDate"), 6, 2)), INTEGER(SUBSTRING(joWx:GetCharacter("baseDate"), 9, 2)), INTEGER(SUBSTRING(joWx:GetCharacter("baseDate"), 1, 4))).
    ja = joWx:GetJsonArray("farms").
    DO i = 1 TO ja:Length:
        jo = ja:GetJsonObject(i).
        FIND Farm WHERE Farm.FarmId = jo:GetInteger("farmId") EXCLUSIVE-LOCK NO-ERROR.
        IF NOT AVAILABLE Farm THEN DO:
            CREATE Farm.
            ASSIGN Farm.FarmId = jo:GetInteger("farmId") Farm.FarmName = jo:GetCharacter("farmName")
                   Farm.Location = jo:GetCharacter("location") Farm.Acreage = jo:GetDecimal("acreage").
            iFarms = iFarms + 1.
        END.
        Farm.Province = jo:GetCharacter("province").
        RELEASE Farm.
    END.
    ja = joWx:GetJsonArray("thresholds").
    DO i = 1 TO ja:Length:
        jo = ja:GetJsonObject(i).
        CREATE AlertThreshold.
        ASSIGN AlertThreshold.ThresholdId = NEXT-VALUE(ThresholdSeq) AlertThreshold.AlertType = jo:GetCharacter("alertType")
               AlertThreshold.Op = jo:GetCharacter("op") AlertThreshold.LimitValue = jo:GetDecimal("value") AlertThreshold.Unit = jo:GetCharacter("unit")
               AlertThreshold.Level = jo:GetCharacter("level") AlertThreshold.Active = TRUE AlertThreshold.UpdatedBy = "seed".
        RELEASE AlertThreshold.
        iWxTh = iWxTh + 1.
    END.
    ja = joWx:GetJsonArray("forecast").
    DO i = 1 TO ja:Length:
        jo = ja:GetJsonObject(i).
        CREATE ForecastDay.
        ASSIGN ForecastDay.ForecastId = NEXT-VALUE(ForecastSeq) ForecastDay.Province = jo:GetCharacter("province") ForecastDay.BaseDate = dWxBase
               ForecastDay.DayNo = jo:GetInteger("dayNo") ForecastDay.ForecastDate = dWxBase + jo:GetInteger("dayNo") - 1
               ForecastDay.TempMaxC = jo:GetDecimal("tempMaxC") ForecastDay.TempMinC = jo:GetDecimal("tempMinC") ForecastDay.RainMm = jo:GetDecimal("rainMm")
               ForecastDay.IsSynthetic = TRUE ForecastDay.Source = "example".
        RELEASE ForecastDay.
        iWxDays = iWxDays + 1.
    END.
    /* ---- plant doctor (feature 1): the no-doses word list (feature 2) */
    CURRENT-VALUE(TermSeq) = 0. CURRENT-VALUE(DiagnosisSeq) = 0.
    ja = joDr:GetJsonArray("blockedTerms").
    DO i = 1 TO ja:Length:
        jo = ja:GetJsonObject(i).
        CREATE BlockedTerm.
        ASSIGN BlockedTerm.TermId = NEXT-VALUE(TermSeq) BlockedTerm.TermText = jo:GetCharacter("term") BlockedTerm.TermKind = jo:GetCharacter("kind")
               BlockedTerm.Active = TRUE BlockedTerm.UpdatedBy = "seed".
        RELEASE BlockedTerm.
        iDrTerms = iDrTerms + 1.
    END.
END.
MESSAGE SUBSTITUTE("SEED OK: &1 farm(s), &2 plots, &3 readings, &4 suggestions, &5 members, &6 credits, &7 lots, &8 contracts (EXAMPLE DATA)", iFarms, iPlots, iReads, iSugg, iMembers, iCredits, iLots, iContracts).
MESSAGE SUBSTITUTE("MARKET SEED OK: &1 retail prices, &2 events, &3 items, &4 reservations (EXAMPLE DATA)", iPrices, iEvents, iItems, iRes).
MESSAGE SUBSTITUTE("WEATHER SEED OK: &1 forecast days, &2 thresholds (FICTIONAL EXAMPLE FORECAST)", iWxDays, iWxTh).
MESSAGE SUBSTITUTE("DOCTOR SEED OK: &1 blocked terms", iDrTerms).
