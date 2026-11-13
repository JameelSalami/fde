{-# LANGUAGE OverloadedStrings #-}
module Main (main) where
import Data.Aeson (Value(..), eitherDecodeStrict', encode, object, (.=))
import qualified Data.Aeson.KeyMap as KM
import qualified Data.ByteString as Strict
import qualified Data.ByteString.Lazy.Char8 as Out
import Data.Text (Text)
import FDE.AdmissionWire (processAdmission)
import FDE.Kernel (compile)
import FDE.IndustrialWire (processIndustrial)
import FDE.ProductionReportWire (processProductionReport)
import FDE.SemanticWire (processSemantic)
import FDE.Wire (parseInput,renderDecision)

main :: IO ()
main = do
  bytes <- Strict.getContents
  let reply
        | Strict.length bytes > 131072 =
            object ["ok" .= False, "error" .= ("input-budget" :: String)]
        | otherwise = case eitherDecodeStrict' bytes :: Either String Value of
            Left _ -> object ["ok" .= False, "error" .= ("invalid-json" :: String)]
            Right candidate -> case dispatch candidate of
              Left reason -> object ["ok" .= False, "error" .= reason]
              Right result -> object ["ok" .= True, "result" .= result]
  Out.putStrLn (encode reply)

dispatch :: Value -> Either Text Value
dispatch candidate = case candidate of
  Object o | KM.lookup "schema" o == Just (String "fde.production-kpi-request/v1") -> processProductionReport candidate
  Object o | KM.lookup "schema" o == Just (String "fde.industrial-assessment-request/v1") ||
             KM.lookup "schema" o == Just (String "fde.industrial-case-assessment-request/v1") ||
             KM.lookup "schema" o == Just (String "fde.industrial-catalog-request/v1") -> processIndustrial candidate
  Object o | KM.lookup "schema" o == Just (String "fde.w1-admission-request/v1") ||
             KM.lookup "schema" o == Just (String "fde.w1-replay-request/v1") -> processAdmission candidate
  Object o | KM.lookup "schema" o == Just (String "fde.semantic-catalog-request/v1") ||
             KM.lookup "schema" o == Just (String "fde.semantic-package-request/v1") ||
             KM.lookup "schema" o == Just (String "fde.claim-relation-request/v1") -> processSemantic candidate
  _ -> renderDecision <$> (parseInput candidate >>= compile)
