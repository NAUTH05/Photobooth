param(
    [string]$printerName,
    [string]$imagePath,
    [string]$offsetXStr = "0", 
    [string]$offsetYStr = "0", 
    [string]$widthMmStr = "0", 
    [string]$heightMmStr = "0",
    [string]$orientation = "portrait",
    [string]$enable2x6 = "false",
    [string]$targetDpi = "300"
)

function Parse-Double($val) {
    if ([string]::IsNullOrEmpty($val)) { return 0 }
    return [double]::Parse($val.ToString().Replace(",", "."), [System.Globalization.CultureInfo]::InvariantCulture)
}

$offsetX = Parse-Double $offsetXStr
$offsetY = Parse-Double $offsetYStr
$widthMm = Parse-Double $widthMmStr
$heightMm = Parse-Double $heightMmStr
$is2x6 = if ($enable2x6 -eq "true") { $true } else { $false }
$dpiVal = [int]$targetDpi

Add-Type -AssemblyName System.Drawing

$printDoc = New-Object System.Drawing.Printing.PrintDocument

# --- 0. SMART PRINTER DETECTION ---
$installedPrinters = [System.Drawing.Printing.PrinterSettings]::InstalledPrinters
if ([string]::IsNullOrEmpty($printerName) -or ($installedPrinters -notcontains $printerName)) {
    Write-Host "Searching for fallback photobooth printer..."
    $fallback = $null
    foreach ($p in $installedPrinters) {
        if ($p -match "RX1" -or $p -match "DNP" -or $p -match "Citizen" -or $p -match "CY-02" -or $p -match "HiTi" -or $p -match "Mitsubishi") {
            $fallback = $p
            break
        }
    }

    if ($fallback) {
        Write-Host "Found fallback printer: '$fallback'"
        $printerName = $fallback
    }
    elseif ($installedPrinters.Count -gt 0) {
        $printerName = [System.Drawing.Printing.PrinterSettings]::new().PrinterName
    }
    else {
        Write-Host "FATAL: No printers found!"
        exit 1
    }
}

$printDoc.PrinterSettings.PrinterName = $printerName

# --- 1. SET ORIENTATION ---
if ($orientation -eq "landscape") {
    $printDoc.DefaultPageSettings.Landscape = $true
} else {
    $printDoc.DefaultPageSettings.Landscape = $false
}

# --- 2. SET RESOLUTION (DPI) ---
$resolutions = $printDoc.PrinterSettings.PrinterResolutions
foreach ($res in $resolutions) {
    if ($res.Kind -ne "Custom") {
        if ($dpiVal -ge 600 -and ($res.X -ge 600 -or $res.Y -ge 600)) {
            $printDoc.DefaultPageSettings.PrinterResolution = $res
            break
        }
        elseif ($dpiVal -lt 600 -and $res.X -le 350) {
            $printDoc.DefaultPageSettings.PrinterResolution = $res
            break
        }
    }
}

# --- 3. CHECK & FORCE PAPER SIZE (With 2x6 Cut Support) ---
if ($widthMm -gt 0 -and $heightMm -gt 0) {
    $wHun = [math]::Round($widthMm / 25.4 * 100)
    $hHun = [math]::Round($heightMm / 25.4 * 100)
    
    $searchW = if ($wHun -lt $hHun) { $wHun } else { $hHun }
    $searchH = if ($wHun -lt $hHun) { $hHun } else { $wHun }

    $sizes = $printDoc.PrinterSettings.PaperSizes
    $bestMatch = $null
    
    foreach ($s in $sizes) {
        $diffW = [math]::Abs($s.Width - $searchW)
        $diffH = [math]::Abs($s.Height - $searchH)

        if ($diffW -lt 20 -and $diffH -lt 20) {
            if ($is2x6) {
                if ($s.PaperName.Contains("2x6") -or $s.PaperName.Contains("x2") -or $s.PaperName.Contains("x 2") -or $s.PaperName.Contains("Cut")) {
                    $bestMatch = $s
                    break
                }
                if ($bestMatch -eq $null) { $bestMatch = $s }
            } 
            else {
                if (-not ($s.PaperName.Contains("2x6") -or $s.PaperName.Contains("x2") -or $s.PaperName.Contains("x 2"))) {
                    $bestMatch = $s
                    break
                }
            }
        }
    }
    
    if ($bestMatch -eq $null) {
        foreach ($s in $sizes) {
            if (($s.PaperName.Contains("4x6") -or $s.PaperName.Contains("PC")) -and ($s.Width -ge 390 -and $s.Width -le 410)) {
                if ($is2x6 -and ($s.PaperName.Contains("2x6") -or $s.PaperName.Contains("x2") -or $s.PaperName.Contains("x 2"))) {
                    $bestMatch = $s; break
                }
                if (-not $is2x6 -and -not ($s.PaperName.Contains("2x6") -or $s.PaperName.Contains("x 2"))) {
                    $bestMatch = $s; break
                }
            }
        }
    }

    if ($bestMatch) {
        $printDoc.DefaultPageSettings.PaperSize = $bestMatch
    }
}

# --- 4. PRINT HANDLER ---
$printDoc.OriginAtMargins = $false
$printDoc.DefaultPageSettings.Margins = New-Object System.Drawing.Printing.Margins(0, 0, 0, 0)

$printDoc.Add_PrintPage({
    param($sender, $e)

    $img = [System.Drawing.Image]::FromFile($imagePath)
    $rectX = $offsetX / 25.4 * 100
    $rectY = $offsetY / 25.4 * 100
    $rectW = if ($widthMm -gt 0) { $widthMm / 25.4 * 100 } else { $img.Width / $img.HorizontalResolution * 100 }
    $rectH = if ($heightMm -gt 0) { $heightMm / 25.4 * 100 } else { $img.Height / $img.VerticalResolution * 100 }

    $e.Graphics.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
    $destRect = New-Object System.Drawing.RectangleF($rectX, $rectY, $rectW, $rectH)
    $e.Graphics.DrawImage($img, $destRect)
    $img.Dispose()
})

try {
    $printDoc.Print()
    Write-Host "Success"
}
catch {
    Write-Host "Error: $_"
    exit 1
}
