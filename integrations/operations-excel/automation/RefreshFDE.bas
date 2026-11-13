Attribute VB_Name = "FDE_Refresh"
Option Explicit
' Import only into a separately approved XLSM copy; XLSX template has no embedded macro.
Public Sub RefreshFDEReporting(ByVal asOfISO As String)
    Dim d As Date, oldCalc As XlCalculation
    Dim oldEvents As Boolean, oldScreen As Boolean
    Dim number As Long, description As String
    Dim n As Variant, ws As Worksheet
    oldCalc = Application.Calculation
    oldEvents = Application.EnableEvents
    oldScreen = Application.ScreenUpdating
    On Error GoTo Failed
    If Not asOfISO Like "####-##-##" Then Err.Raise 5, , "ISO date required"
    d = DateSerial(CInt(Left$(asOfISO,4)), CInt(Mid$(asOfISO,6,2)), CInt(Right$(asOfISO,2)))
    If Format$(d,"yyyy-mm-dd") <> asOfISO Then Err.Raise 5, , "Invalid date"
    If ThisWorkbook.Connections.Count <> 0 Then Err.Raise 5, , "Unreviewed external connection"
    For Each n In Array("Template & Rules","Rolling 5 Days","Rolling 12 Months","Current Month", _
              "Production","Quality","Safety","Maintenance","Raw Shifts","Raw EHS","Raw PM", _
              "Raw Downtime","Calendar","Targets")
       Set ws = Nothing
       On Error Resume Next
       Set ws=ThisWorkbook.Worksheets(CStr(n))
       On Error GoTo Failed
       If ws Is Nothing Then Err.Raise 5, , "Missing sheet: " & CStr(n)
    Next n
    Application.EnableEvents=False
    Application.ScreenUpdating=False
    Application.Calculation=xlCalculationManual
    ThisWorkbook.Worksheets("Template & Rules").Range("B3").Value2=CDbl(d)
    Application.CalculateFullRebuild
    GoTo Cleanup
Failed:
    number=Err.Number
    description=Err.Description
Cleanup:
    Application.Calculation=oldCalc
    Application.EnableEvents=oldEvents
    Application.ScreenUpdating=oldScreen
    If number<>0 Then Err.Raise number,"RefreshFDEReporting",description
End Sub
Public Sub RefreshToToday()
    RefreshFDEReporting Format$(Date,"yyyy-mm-dd")
End Sub
