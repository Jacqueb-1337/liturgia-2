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

  ; Default to checked for fresh installs (ignore prior registry to keep default enabled)
  ; (Preserve the user's explicit choice only via the installer UI when they install)
  ; No registry read here to avoid silently turning off the checkbox on upgrade.

  nsDialogs::Show
FunctionEnd

Page custom CreateAutoUpdatePage

Function .onInstSuccess
  ; Write choice to registry so installer choice persists
  ${NSD_GetState} $AUTOCHECK_CTRL $R1
  ${If} $R1 == 1
    WriteRegStr HKCU "Software\Liturgia" "AutoCheckForUpdates" "1"
  ${Else}
    WriteRegStr HKCU "Software\Liturgia" "AutoCheckForUpdates" "0"
  ${EndIf}
FunctionEnd
