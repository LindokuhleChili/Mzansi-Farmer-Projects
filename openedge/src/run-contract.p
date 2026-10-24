/* run-contract.p - run the shared OpenEdge contract cases (eval/oe-contract-cases.json) against farm-api.p
   and write the raw responses to a JSON file. The Node script eval/compare-oe.mjs checks them against `expect`.
   The case file includes co-op cases CO01-CO76. An optional third argument keeps only ids with that prefix.
   Usage: _progres -b -db farm ... -p run-contract.p -param "cases.json|results.json"
          _progres -b -db farm ... -p run-contract.p -param "cases.json|results.json|CO" */
USING Progress.Json.ObjectModel.JsonObject.
USING Progress.Json.ObjectModel.JsonArray.
USING Progress.Json.ObjectModel.ObjectModelParser.

DEFINE VARIABLE oParser AS ObjectModelParser NO-UNDO.
DEFINE VARIABLE jInput  AS JsonObject NO-UNDO.
DEFINE VARIABLE jOutput AS JsonObject NO-UNDO.
DEFINE VARIABLE jaIn  AS JsonArray  NO-UNDO.
DEFINE VARIABLE jaOut AS JsonArray  NO-UNDO.
DEFINE VARIABLE jc    AS JsonObject NO-UNDO.
DEFINE VARIABLE jr    AS JsonObject NO-UNDO.
DEFINE VARIABLE jReq  AS JsonObject NO-UNDO.
DEFINE VARIABLE jRes  AS JsonObject NO-UNDO.
DEFINE VARIABLE i     AS INTEGER NO-UNDO.
DEFINE VARIABLE iStat AS INTEGER NO-UNDO.
DEFINE VARIABLE cBody AS LONGCHAR NO-UNDO.
DEFINE VARIABLE cResp AS LONGCHAR NO-UNDO.
DEFINE VARIABLE cArgs AS CHARACTER NO-UNDO.
DEFINE VARIABLE cPrefix AS CHARACTER NO-UNDO.
DEFINE VARIABLE iRan AS INTEGER NO-UNDO.

cArgs = SESSION:PARAMETER.
IF NUM-ENTRIES(cArgs, "|") >= 3 THEN cPrefix = ENTRY(3, cArgs, "|").
oParser = NEW ObjectModelParser().
jInput = CAST(oParser:ParseFile(ENTRY(1, cArgs, "|")), JsonObject).
jaIn = jInput:GetJsonArray("cases").
jaOut = NEW JsonArray().
DO i = 1 TO jaIn:Length:
    jc = jaIn:GetJsonObject(i).
    IF cPrefix <> "" AND NOT (jc:GetCharacter("id") BEGINS cPrefix) THEN NEXT.
    iRan = iRan + 1.
    jReq = jc:GetJsonObject("request").
    cBody = "".
    IF jReq:Has("body") THEN jReq:GetJsonObject("body"):Write(INPUT-OUTPUT cBody, FALSE).
    cResp = "".
    RUN farm-api.p (jReq:GetCharacter("method"), jReq:GetCharacter("path"), cBody, OUTPUT iStat, OUTPUT cResp).
    jr = NEW JsonObject().
    jr:Add("id", jc:GetCharacter("id")).
    jr:Add("status", iStat).
    oParser = NEW ObjectModelParser().
    jRes = CAST(oParser:Parse(cResp), JsonObject).
    jr:Add("body", jRes).
    jaOut:Add(jr).
END.
jOutput = NEW JsonObject().
jOutput:Add("target", "abl").
jOutput:Add("results", jaOut).
jOutput:WriteFile(ENTRY(2, cArgs, "|"), TRUE).
MESSAGE SUBSTITUTE("CONTRACT RUN DONE: &1 cases executed", iRan).
