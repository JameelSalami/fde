param([Parameter(Mandatory=$true)][string]$Template,
      [Parameter(Mandatory=$true)][string]$Output,
      [Parameter(Mandatory=$true)][string]$AsOfDate)
$ErrorActionPreference="Stop"
$src=[IO.Path]::GetFullPath($Template)
$dest=[IO.Path]::GetFullPath($Output)
if($src -eq $dest -or !(Test-Path -LiteralPath $src -PathType Leaf) -or
   (Test-Path -LiteralPath $dest) -or
   [IO.Path]::GetExtension($src) -ne ".xlsx" -or
   [IO.Path]::GetExtension($dest) -ne ".xlsx") {throw "Refused source/target workbook"}
$day=[datetime]::ParseExact($AsOfDate,"yyyy-MM-dd",
             [Globalization.CultureInfo]::InvariantCulture)
$xl=$null;$wb=$null
try {
 $xl=New-Object -ComObject Excel.Application
 $xl.Visible=$false;$xl.DisplayAlerts=$false;$xl.AskToUpdateLinks=$false
 $xl.EnableEvents=$false;$xl.AutomationSecurity=3
 $wb=$xl.Workbooks.Open($src,0,$true)
 if($wb.Connections.Count -ne 0){throw "Unreviewed data connection"}
 foreach($name in @("Template & Rules","Rolling 5 Days","Rolling 12 Months",
                    "Current Month","Production","Quality","Safety",
                    "Maintenance","Raw Shifts","Raw EHS","Raw PM",
                    "Raw Downtime","Calendar","Targets")) {
    if($null -eq $wb.Worksheets.Item($name)){throw "Missing sheet: "+$name}
 }
 $wb.Worksheets.Item("Template & Rules").Range("B3").Value2=[double]$day.ToOADate()
 $xl.CalculateFullRebuild()
 if([double]$wb.Worksheets.Item("Rolling 5 Days").Range("B8").Value2 -le 0){
     throw "Latest scheduled day not calculated"
 }
 $wb.SaveAs($dest,51)
 $wb.Close($false);$wb=$null
 [ordered]@{status="recalculated-new-workbook";output=$dest;
   asOf=$AsOfDate;excelVersion=$xl.Version;sourceWrites=0;AzureCalls=0}|
   ConvertTo-Json -Compress
} finally {
 if($null -ne $wb){$wb.Close($false);[void][Runtime.InteropServices.Marshal]::FinalReleaseComObject($wb)}
 if($null -ne $xl){$xl.Quit();[void][Runtime.InteropServices.Marshal]::FinalReleaseComObject($xl)}
}
