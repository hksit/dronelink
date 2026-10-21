; Lets phones and controllers on the Wi-Fi reach DroneLink without a firewall prompt.
; Covers Private and Public profiles because many home/venue networks are marked Public.
!macro customInstall
  nsExec::ExecToLog 'netsh advfirewall firewall delete rule name="DroneLink"'
  nsExec::ExecToLog 'netsh advfirewall firewall add rule name="DroneLink" dir=in action=allow program="$INSTDIR\DroneLink.exe" enable=yes profile=any'
!macroend

!macro customUnInstall
  nsExec::ExecToLog 'netsh advfirewall firewall delete rule name="DroneLink"'
!macroend
