!include "MUI2.nsh"
!include "LogicLib.nsh"

Var AUTOCHECK

Function CreateAutoUpdatePage
  ; Default to enabled
  StrCpy $AUTOCHECK 1
  nsDialogs::Create 1018
  Pop $0
  ${If} $0 == error
    Abort
  ${EndIf}

  ; Title
  ${NSD_CreateLabel} 10u 10u 100% 12u "Enable automatic update checks when Liturgia starts"
  Pop $1

  ; Checkbox
  ${NSD_CreateCheckBox} 10u 30u 100% 12u "Check for updates on startup"
  Pop $2
  ${NSD_Check} $2

  ; Set initial value from registry if present
  ClearErrors
  ReadRegStr $R0 HKCU "Software\Liturgia" "AutoCheckForUpdates"
  ${If} ${Errors}
    ; nothing
  ${Else}
    ${If} $R0 == 0
      ${NSD_UnCheck} $2
      StrCpy $AUTOCHECK 0
    ${EndIf}
  ${EndIf}

  nsDialogs::Show
FunctionEnd

Page custom CreateAutoUpdatePage

Function .onInstSuccess
  ; Write choice to registry so installer choice persists
  ${NSD_GetState} $2 $R1
  ${If} $R1 == 1
    WriteRegStr HKCU "Software\Liturgia" "AutoCheckForUpdates" "1"
  ${Else}
    WriteRegStr HKCU "Software\Liturgia" "AutoCheckForUpdates" "0"
  ${EndIf}
FunctionEnd
