/* run-contract.p - run the shared OpenEdge contract cases (eval/oe-contract-cases.json) against farm-api.p
   and write the raw responses to a JSON file. The Node script eval/compare-oe.mjs checks them against `expect`.
   Usage: _progres -b -db farm ... -p run-contract.p -param "cases.json|results.json" */
USING Progress.Json.ObjectModel.JsonObject.
USING Progress.Json.ObjectModel.JsonArray.
USING Progress.Json.ObjectModel.ObjectModelParser.

DEFINE VARIABLE oParser AS ObjectModelParser NO-UNDO.
DEFINE VARIABLE joIn  AS JsonObject NO-UNDO.
DEFINE VARIABLE joOut AS JsonObject NO-UNDO.
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

cArgs = SESSION:PARAMETER.
oParser = NEW ObjectModelParser().
joIn = CAST(oParser:ParseFile(ENTRY(1, cArgs, "|")), JsonObject).
jaIn = joIn:GetJsonArray("cases").
jaOut = NEW JsonArray().
DO i = 1 TO jaIn:Length:
    jc = jaIn:GetJsonObject(i).
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
joOut = NEW JsonObject().
joOut:Add("target", "abl").
joOut:Add("results", jaOut).
joOut:WriteFile(ENTRY(2, cArgs, "|"), TRUE).
MESSAGE SUBSTITUTE("CONTRACT RUN DONE: &1 cases executed", jaIn:Length).
