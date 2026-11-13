{-# LANGUAGE OverloadedStrings #-}
module Main (main) where
import Data.Aeson (Value(..),object,(.=))
import qualified Data.Aeson.KeyMap as KM
import Data.Text (Text)
import System.Exit (exitFailure)
import FDE.ProductionReport
import FDE.ProductionReportWire

check :: String -> Bool -> IO ()
check label good=if good then putStrLn ("PASS "++label)
  else putStrLn ("FAIL "++label) >> exitFailure

base :: ProductionInput
base=ProductionInput "SHIFT-A-20261112" "LINE-2" "handwritten-fixture" 960 827
  [Loss "bearing" 77,Loss "changeover" 31,Loss "rejects" 19,Loss "microstop" 6]

request :: Value
request=object
  ["schema".=("fde.production-kpi-request/v1"::Text),
   "periodId".=("SHIFT-A-20261112"::Text),
   "lineId".=("LINE-2"::Text),
   "sourceClass".=("handwritten-fixture"::Text),
   "plannedUnits".=("960"::Text),
   "goodUnits".=("827"::Text),
   "losses".=([object ["id".=("bearing"::Text),"units".=("77"::Text)]]::[Value])]

main :: IO ()
main=do
  check "R01 reconciled KPI and 86.15 percent" $ case assessProduction base of
    Right r->resultShortfall r==133 && resultLossTotal r==133 &&
      resultAttainmentBps r==Just 8615 && resultLossStatus r=="reconciled"
    _->False
  check "R02 half-up tie 1/32 is 3.13 percent" $
    fmap resultAttainmentBps (assessProduction base{plannedUnits=32,goodUnits=1,lossCategories=[]})
      == Right (Just 313)
  check "R03 zero denominator remains unknown" $ case
    assessProduction base{plannedUnits=0,goodUnits=0,lossCategories=[]} of
      Right r->resultAttainmentBps r==Nothing && resultLossStatus r=="unknown-plan"
      _->False
  check "R04 uncategorized gap is explicit" $ case
    assessProduction base{lossCategories=[Loss "bearing" 77]} of
      Right r->resultUnclassified r==56 && resultLossStatus r=="incomplete-loss-categories"
      _->False
  check "R05 categorized loss beyond gap cannot be reconciled" $ case
    assessProduction base{lossCategories=[Loss "bearing" 134]} of
      Right r->resultLossStatus r=="loss-categories-exceed-gap"
      _->False
  check "R06 negative or excessive good refuses" $
    assessProduction base{goodUnits=961}==Left "invalid-planned-or-good-quantity"
  check "R07 duplicate loss category refuses" $
    assessProduction base{lossCategories=[Loss "duplicate" 1,Loss "duplicate" 2]}
      == Left "invalid-or-duplicate-loss-category"
  check "R08 closed wire request returns incomplete status" $ case
    processProductionReport request of
      Right (Object o)->KM.lookup "lossStatus" o==Just (String "incomplete-loss-categories")
      _->False
  check "R09 result never authorizes vendor effects" $ case
    assessProduction base of
      Right r->case renderProduction r of
        Object o->KM.lookup "authority" o==Just (String "non-authoritative-diagnostic") &&
           KM.lookup "sourceWriteAllowed" o==Just (Bool False)
        _->False
      _->False
  check "R10 unsupported source claims refuse" $
    assessProduction base{sourceClass="verified-production"}
      == Left "unsupported-report-source-class"
