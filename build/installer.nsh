!include "MUI2.nsh"
!include "LogicLib.nsh"

Var AUTOCHECK
Var AUTOCHECK_CTRL

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
  Pop $AUTOCHECK_CTRL
  ${NSD_Check} $AUTOCHECK_CTRL

  ; Set initial value from registry if present (preserve explicit user choice on upgrades)
  ClearErrors
  ReadRegStr $R0 HKCU "Software\Liturgia" "AutoCheckForUpdates"
  ${If} ${Errors}
    ; nothing
  ${Else}
    ${If} $R0 == 0
      ${NSD_UnCheck} $AUTOCHECK_CTRL
      StrCpy $AUTOCHECK 0
    ${EndIf}
  ${EndIf}

  nsDialogs::Show
FunctionEnd

Function LeaveAutoUpdatePage
  ; Capture state while the dialog is still alive (control handle is valid here).
  ; .onInstSuccess runs after the page is destroyed so NSD_GetState would return 0 there.
  ${NSD_GetState} $AUTOCHECK_CTRL $R1
  ${If} $R1 == 1
    StrCpy $AUTOCHECK 1
  ${Else}
    StrCpy $AUTOCHECK 0
  ${EndIf}
FunctionEnd

Page custom CreateAutoUpdatePage LeaveAutoUpdatePage

Function .onInstSuccess
  ; Use the value captured in LeaveAutoUpdatePage — never read the control here.
  ${If} $AUTOCHECK == 1
    WriteRegStr HKCU "Software\Liturgia" "AutoCheckForUpdates" "1"
  ${Else}
    WriteRegStr HKCU "Software\Liturgia" "AutoCheckForUpdates" "0"
  ${EndIf}
FunctionEnd
