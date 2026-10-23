/*------------------------------------------------------------------------
  web/FarmHandler.cls - PASOE WEB-transport handler. Thin wrapper: every request is passed to farm-api.p,
  which holds all business rules and data access. Mapped to /web/farm/ ... (see docs/OE-CONTRACT.md).
  STATUS: written to the PASOE WebHandler pattern; see docs/NOTES.md for whether it has been deployed and run.
------------------------------------------------------------------------*/
USING OpenEdge.Web.WebHandler.
USING OpenEdge.Web.IWebRequest.
USING OpenEdge.Web.WebResponse.
USING OpenEdge.Web.WebResponseWriter.
USING OpenEdge.Core.String.
USING OpenEdge.Net.HTTP.StatusCodeEnum.
USING Progress.Json.ObjectModel.JsonObject.

BLOCK-LEVEL ON ERROR UNDO, THROW.

CLASS web.FarmHandler INHERITS WebHandler:

    METHOD OVERRIDE PROTECTED INTEGER HandleGet(INPUT poRequest AS IWebRequest):
        RETURN Dispatch(poRequest, "GET").
    END METHOD.

    METHOD OVERRIDE PROTECTED INTEGER HandlePost(INPUT poRequest AS IWebRequest):
        RETURN Dispatch(poRequest, "POST").
    END METHOD.

    METHOD PRIVATE INTEGER Dispatch(INPUT poRequest AS IWebRequest, INPUT pcMethod AS CHARACTER):
        DEFINE VARIABLE oResponse AS WebResponse NO-UNDO.
        DEFINE VARIABLE oWriter   AS WebResponseWriter NO-UNDO.
        DEFINE VARIABLE lcBody    AS LONGCHAR NO-UNDO.
        DEFINE VARIABLE lcResp    AS LONGCHAR NO-UNDO.
        DEFINE VARIABLE cPath     AS CHARACTER NO-UNDO.
        DEFINE VARIABLE iStatus   AS INTEGER NO-UNDO.

        cPath = poRequest:URI:Path.
        IF poRequest:URI:Query > "" THEN cPath = cPath + "?" + poRequest:URI:Query.

        IF VALID-OBJECT(poRequest:Entity) THEN DO:
            IF TYPE-OF(poRequest:Entity, JsonObject) THEN
                CAST(poRequest:Entity, JsonObject):Write(INPUT-OUTPUT lcBody, FALSE).
            ELSE IF TYPE-OF(poRequest:Entity, String) THEN
                lcBody = CAST(poRequest:Entity, String):Value.
        END.

        RUN farm-api.p (pcMethod, cPath, lcBody, OUTPUT iStatus, OUTPUT lcResp).

        oResponse = NEW WebResponse().
        oResponse:StatusCode = iStatus.
        oResponse:ContentType = "application/json".
        oResponse:Entity = NEW String(lcResp).
        oWriter = NEW WebResponseWriter(oResponse).
        oWriter:Open().
        oWriter:Close().
        RETURN 0.
    END METHOD.

END CLASS.
