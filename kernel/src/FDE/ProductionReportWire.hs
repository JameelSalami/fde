{-# LANGUAGE OverloadedStrings #-}
module FDE.ProductionReportWire (processProductionReport) where
import Control.Monad (unless)
import Data.Aeson (Value(..), (.:), withObject)
import Data.Aeson.Key (Key)
import qualified Data.Aeson.Key as Key
import qualified Data.Aeson.KeyMap as KM
import Data.Aeson.Types (Parser, parseEither)
import Data.Char (isDigit,isAscii)
import Data.List (sort)
import Data.Text (Text)
import qualified Data.Text as T
import FDE.ProductionReport

exact :: [Text] -> KM.KeyMap Value -> Parser ()
exact names obj=unless (sort (map Key.toText (KM.keys obj))==sort names)
   (fail "unknown-kpi-input-field")

count :: KM.KeyMap Value -> Key -> Parser Integer
count obj key=do
  s <- obj .: key :: Parser Text
  unless (T.length s<=16 && (s=="0" || (not (T.null s) && T.head s/='0' &&
     T.all (\c -> isAscii c && isDigit c) s))) (fail "invalid-kpi-count")
  let n=read (T.unpack s) :: Integer
  unless (n<=9007199254740991) (fail "unsafe-kpi-count")
  pure n

loss :: Value -> Parser Loss
loss=withObject "loss" $ \obj -> do
  exact ["id","units"] obj
  Loss <$> obj .: "id" <*> count obj "units"

parseReport :: Value -> Parser ProductionInput
parseReport=withObject "production report" $ \obj -> do
  exact ["schema","periodId","lineId","sourceClass","plannedUnits","goodUnits","losses"] obj
  schema <- obj .: "schema" :: Parser Text
  unless (schema=="fde.production-kpi-request/v1") (fail "invalid-kpi-schema")
  losses <- obj .: "losses" :: Parser [Value]
  unless (length losses<=32) (fail "too-many-loss-categories")
  ProductionInput <$> obj .: "periodId"
     <*> obj .: "lineId"
     <*> obj .: "sourceClass"
     <*> count obj "plannedUnits"
     <*> count obj "goodUnits"
     <*> traverse loss losses

processProductionReport :: Value -> Either Text Value
processProductionReport value=do
  input <- case parseEither parseReport value of
    Left _ -> Left "invalid-production-kpi-request"
    Right x -> Right x
  renderProduction <$> assessProduction input
