param([Parameter(Mandatory=$true)][string]$Workbook)
# Read-only, independent Windows Excel 16 acceptance gate.
$ErrorActionPreference="Stop"
$p=[IO.Path]::GetFullPath($Workbook)
if(!(Test-Path -LiteralPath $p -PathType Leaf) -or [IO.Path]::GetExtension($p) -ne ".xlsx"){
 throw "Missing mart workbook"
}
$xl=$null;$wb=$null
try{
 $xl=New-Object -ComObject Excel.Application
 $xl.Visible=$false;$xl.DisplayAlerts=$false
 $xl.AskToUpdateLinks=$false
 $xl.AutomationSecurity=3
 $wb=$xl.Workbooks.Open($p,0,$true)
 $names=@("Read Me","Template & Rules","Rolling 5 Days","Rolling 12 Months",
   "Current Month","Production","Quality","Safety","Maintenance",
   "Action Tracker","Raw Shifts","Raw EHS","Raw PM","Raw Downtime","Calendar","Targets")
 if($wb.Worksheets.Count -ne 16){throw "Workbook sheet count"}
 foreach($n in $names){if($null -eq $wb.Worksheets.Item($n)){throw "Required tab missing: $n"}}
 $current=$wb.Worksheets.Item("Current Month")
 $five=$wb.Worksheets.Item("Rolling 5 Days")
 $twelve=$wb.Worksheets.Item("Rolling 12 Months")
 $prod=$wb.Worksheets.Item("Production")
 $qual=$wb.Worksheets.Item("Quality")
 $safety=$wb.Worksheets.Item("Safety")
 $maint=$wb.Worksheets.Item("Maintenance")
 if([math]::Abs([double]$current.Range("C8").Value2-0.8526) -gt 0.000001){throw "Production month KPI"}
 if([math]::Abs([double]$current.Range("C9").Value2-0.8889) -gt 0.000001){throw "Quality month KPI"}
 if([math]::Abs([double]$current.Range("C10").Value2-181.16) -gt 0.0001){throw "Safety month KPI"}
 if($current.Range("C11").Text.Trim() -ne ""){throw "PM not-due must be blank"}
 if($five.Range("A8").Text -ne "2026-11-12"){throw "Five-day cutoff"}
 if([math]::Abs([double]$five.Range("D8").Value2-0.7895) -gt 0.000001){throw "Five-day attainment"}
 if($five.Range("E8").Value2 -ne 0){throw "Native MES output contamination"}
 if($twelve.Range("A8").Text -ne "2026-10"){throw "Latest closed month"}
 if([math]::Abs([double]$twelve.Range("D8").Value2-0.8843) -gt 0.000001){throw "Twelve-month attainment"}
 if($prod.Range("A8").Text -ne "2026-11"){throw "Production period"}
 if([math]::Abs([double]$qual.Range("E8").Value2-0.8889) -gt 0.000001){throw "Quality workspace"}
 if([math]::Abs([double]$safety.Range("D8").Value2-181.16) -gt 0.0001){throw "Safety workspace"}
 if($maint.Range("D8").Text.Trim() -ne ""){throw "Maintenance future PM"}
 if($twelve.ChartObjects().Count -lt 1){throw "Missing trend chart"}
 if($wb.Connections.Count -ne 0){throw "External connection present"}
 if($wb.LinkSources(1)){throw "External workbook links present"}
 $result=[ordered]@{
  status="COM_VERIFIED";ExcelVersion=$xl.Version
  sheetCount=$wb.Worksheets.Count
  latestDay=$five.Range("A8").Text
  currentScenario=[double]$current.Range("C8").Value2
  currentQc=[double]$current.Range("C9").Value2
  latestClosed=$twelve.Range("A8").Text
  futurePmStatus="blank-not-due"
  nativeMesProduced=[double]$five.Range("E8").Value2
  monthlyCharts=$twelve.ChartObjects().Count
  externalConnections=$wb.Connections.Count
  readOnly=$wb.ReadOnly
 }
 $result|ConvertTo-Json -Compress
}finally{
 if($wb){$wb.Close($false);[void][Runtime.InteropServices.Marshal]::FinalReleaseComObject($wb)}
 if($xl){$xl.Quit();[void][Runtime.InteropServices.Marshal]::FinalReleaseComObject($xl)}
}
