import Promise = require('bluebird');
import {Inject} from "di-ts";
import {bookshelf} from "../bookshelf";
import {IEvseDataRoot} from "../interfaces/IEvseDataRoot";
import {Accessibility} from "../models/Accessibility";
import {AuthenticationMode} from "../models/AuthenticationMode";
import {ChargingFacility} from "../models/ChargingFacility";
import {ChargingMode} from "../models/ChargingMode";
import {Plug} from "../models/Plug";
import {ValueAddedService} from "../models/ValueAddedService";
import {IOperatorEvseData} from "../interfaces/IOperatorEvseData";
import {IEvseDataRecord} from "../interfaces/IEvseDataRecord";
import {IOperator} from "../interfaces/IOperator";
import {DataImportHelper} from "./DataImportHelper";
import {IEnum} from "../interfaces/IEnum";
import {IEVSEAuthenticationMode} from "../interfaces/IEVSEAuthenticationMode";
import {IEVSEChargingMode} from "../interfaces/IEVSEChargingMode";
import {IEVSEPaymentOption} from "../interfaces/IEVSEPaymentOption";
import {PaymentOption} from "../models/PaymentOption";
import {IEVSEPlug} from "../interfaces/IEVSEPlug";
import {IEVSEValueAddedService} from "../interfaces/IEVSEValueAddedService";
import Knex = require("knex");

@Inject
export class DataImporter {

  private accessibilities;
  private authenticationModes;
  private chargingFacilities;
  private chargingModes;
  private paymentOptions;
  private plugs;
  private valueAddedServices;

  constructor(protected dataImportHelper: DataImportHelper) {

  }

  /**
   * Executes data import process, which includes filtering and mapping
   * of hbs operator data and hbs evse data. The prepared data will finally
   * stored into database.
   */
  execute(data: IEvseDataRoot) {

    const operatorData: IOperatorEvseData[] = data.EvseData.OperatorEvseData;

    return this.loadDependentData()
      .then(() => this.processOperatorData(operatorData))
      .then(() => this.processEvseData(operatorData))
      ;
  }

  /**
   * Loads enum data and operator data for setting relations during
   * import process
   */
  private loadDependentData() {

    return Promise
      .all([
        this.accessibilities || Accessibility.fetchAll(),
        this.authenticationModes || AuthenticationMode.fetchAll(),
        this.chargingFacilities || ChargingFacility.fetchAll(),
        this.chargingModes || ChargingMode.fetchAll(),
        this.paymentOptions || PaymentOption.fetchAll(),
        this.plugs || Plug.fetchAll(),
        this.valueAddedServices || ValueAddedService.fetchAll(),
      ])
      .spread((accessibilities,
               authenticationModes,
               chargingFacilities,
               chargingModes,
               paymentOptions,
               plugs,
               valueAddedServices) => {

        this.accessibilities = accessibilities;
        this.authenticationModes = authenticationModes;
        this.chargingFacilities = chargingFacilities;
        this.chargingModes = chargingModes;
        this.paymentOptions = paymentOptions;
        this.plugs = plugs;
        this.valueAddedServices = valueAddedServices;
      })
      ;
  }

  /**
   * Removes all EVSE data including their relational data
   */
  private clearData(trx: Knex) {

    return trx('EVSE').delete();
  }

  /**
   * Processes operator data.
   *  - Maps hbs structure to internal model.
   *  - stores new operators into database
   */
  private processOperatorData(operatorData: IOperatorEvseData[]): Promise<void> {

    const operators: IOperator[] = this.mapOperatorDataToOperators(operatorData);

    return bookshelf.knex.transaction((trx: any) => {

      return trx('Operator').delete()
        .then(() => trx('Operator').insertOrUpdate(operators))
        ;
    });
  }

  /**
   * Converts hbs operator data to IOperator interface
   */
  private mapOperatorDataToOperators(operatorData: IOperatorEvseData[]): IOperator[] {

    return operatorData
      .map(data => ({
          id: data.OperatorID,
          name: data.OperatorName
        })
      );
  }


  /**
   * Processes evse data:
   * - retrieves evse data from operator data
   * - creates sub operators from evse data
   * - maps evse data
   * - stores mapped evse data into database
   * - processes international data
   * - processes relational enum types from evse data
   */
  private processEvseData(operatorData: IOperatorEvseData[]) {

    const evseData: IEvseDataRecord[] = this.retrieveEvseDataFromOperatorData(operatorData);

    return bookshelf.knex.transaction((trx: any) => {

      return this.clearData(trx)
        .then(() => this.processPossibleSubOperatorsFromEvseData(evseData, trx))
        .then(() => {

          const evses = this.mapEvseDataToEvses(evseData);

          return trx('EVSE').insertOrUpdate(evses);
        })
        .then(() => this.processInternationalData(evseData, trx))
        .then(() => this.processEVSERelationalData(evseData, trx))
        ;

    });

  }

  /**
   * This process stores and resolved the fields EnChargingStationName
   * and EnAdditionalInfo of the evse data records in a separate
   * translation table (EVSE_tr).
   */
  private processInternationalData(evseData: IEvseDataRecord[], trx) {

    return this.getInternationalData(evseData)
      .then((evseTrs: IEVSE_tr[]) => trx('EVSE_tr').insertOrUpdate(evseTrs))
      ;
  }

  /**
   * This process resolves the fields EnChargingStationName
   * and EnAdditionalInfo of the evse data records in a separate
   * entities.
   * This process is a little bit problematic, because the
   * EnChargingStationName field is a simple string with an english
   * translation(en-GB) of ChargingStationName. Whereas the
   * EnAdditionalInfo field consists of several information of several
   * languages identified through a regular expression - Example:
   *
   *    “DEU:Inhalt|||GBR:Content|||FRA:Objet||| .
   *
   * These information have to be separated and stored as separate
   * entries.
   * Notice, that both fields are optional.
   */
  private getInternationalData(evseData: IEvseDataRecord[]) {
    const LOCALIZED_INFO_REGEX = new RegExp('([A-Z]{3}):(.*?)\\|\\|\\|', 'g');
    const CHARGING_STATION_NAME_ALPHA_3 = 'DEU';
    const CHARGING_STATION_NAME_ALPHA_3_REGEX = new RegExp(CHARGING_STATION_NAME_ALPHA_3 + ':.*\\|\\|\\|');
    const EN_CHARGING_STATION_NAME_ALPHA_3 = 'GBR';
    const EN_CHARGING_STATION_NAME_ALPHA_3_REGEX = new RegExp(EN_CHARGING_STATION_NAME_ALPHA_3 + ':.*\\|\\|\\|');
    const evseTrsPromises: Promise<IEVSE_tr>[] = [];

    evseData.forEach(data => {

      if (!data.EnAdditionalInfo) return;

      // Create entities for each country information from the
      // EnAdditionalInfo field
      let match = LOCALIZED_INFO_REGEX.exec(data.EnAdditionalInfo);

      while (match != null) {

        let countryAlpha3 = match[1];
        let content = match[2].trim();
        let chargingStationName = null;

        // Get charging station name by alpha 3 code
        if (countryAlpha3 === EN_CHARGING_STATION_NAME_ALPHA_3) {
          chargingStationName = data.EnChargingStationName;
        } else if (countryAlpha3 === CHARGING_STATION_NAME_ALPHA_3) {
          chargingStationName = data.ChargingStationName;
        }

        evseTrsPromises.push(
          this.getEvseTr(countryAlpha3, data.EvseId, chargingStationName, content)
        );

        match = LOCALIZED_INFO_REGEX.exec(data.EnAdditionalInfo);
      }

      // If EnAdditionalInfo does not consist of the language, which
      // is targeted by the EnChargingStationName, the entity has
      // to be created manually:
      if (!EN_CHARGING_STATION_NAME_ALPHA_3_REGEX.test(data.EnAdditionalInfo) &&
        data.EnChargingStationName &&
        data.EnChargingStationName.trim()) {

        evseTrsPromises.push(
          this.getEvseTr(EN_CHARGING_STATION_NAME_ALPHA_3, data.EvseId, data.EnChargingStationName, null)
        );
      }

      // If EnAdditionalInfo does not consist of the language, which
      // is targeted by the ChargingStationName, the entity has
      // to be created manually:
      if (!CHARGING_STATION_NAME_ALPHA_3_REGEX.test(data.EnAdditionalInfo) &&
        data.ChargingStationName &&
        data.ChargingStationName.trim()) {

        evseTrsPromises.push(
          this.getEvseTr(CHARGING_STATION_NAME_ALPHA_3, data.EvseId, data.ChargingStationName, null)
        );
      }

    });

    return Promise.all(evseTrsPromises);
  }

  private getEvseTr(alpha3: string, evseId: string, chargingStationName: string, additionalInfo: string) {

    return this.dataImportHelper.getLanguageCodeByISO3166Alpha3(alpha3)
      .catch(() => {

        // if an error occured, set alpha 3 as language code as a fallback
        return alpha3;
      })
      .then(languageCode => {
        return {evseId, chargingStationName, languageCode, additionalInfo}
      })
      ;
  }

  /**
   * Connects the enum types with the corresponding evse data records;
   * Background: Each evse data record consists of several type
   * options instead of an type identifier. Therefor a N:M Relation
   * for e.g. the AuthenticationModes will be resolved like this:
   *
   * EVSE (1) --- (N) EVSEAuthenticationMode (N) ---- (1) AuthenticationMode
   *
   */
  private processEVSERelationalData(evseData: IEvseDataRecord[], trx: Knex) {

    const evseAuthenticationModes = this.dataImportHelper
      .getEvseRelationByEvseData<IEVSEAuthenticationMode, IEnum>(evseData,
        this.authenticationModes.models,
        'authenticationModeId',
        evseData => evseData.AuthenticationModes ? evseData.AuthenticationModes.AuthenticationMode : []);

    const evseChargingFacilities = this.dataImportHelper
      .getChargingFacilitiesByEvseData(evseData,
        this.chargingFacilities.models);

    const evseChargingModes = this.dataImportHelper
      .getEvseRelationByEvseData<IEVSEChargingMode, IEnum>(evseData,
        this.chargingModes.models,
        'chargingModeId',
        evseData => evseData.ChargingModes ? evseData.ChargingModes.ChargingMode : []);

    const evsePaymentOptions = this.dataImportHelper
      .getEvseRelationByEvseData<IEVSEPaymentOption, IEnum>(evseData,
        this.paymentOptions.models,
        'paymentOptionId',
        evseData => evseData.PaymentOptions ? evseData.PaymentOptions.PaymentOption : []);

    const evsePlugs = this.dataImportHelper
      .getEvseRelationByEvseData<IEVSEPlug, IEnum>(evseData,
        this.plugs.models,
        'plugId',
        evseData => evseData.Plugs ? evseData.Plugs.Plug : []);

    const evseValueAddedServices = this.dataImportHelper
      .getEvseRelationByEvseData<IEVSEValueAddedService, IEnum>(evseData,
        this.valueAddedServices.models,
        'valueAddedServiceId',
        evseData => evseData.ValueAddedServices ? evseData.ValueAddedServices.ValueAddedService : []);

    return Promise.all([
      evseAuthenticationModes.length ? trx('EVSEAuthenticationMode').insertOrUpdate(evseAuthenticationModes) : null,
      evseChargingFacilities.length ? trx('EVSEChargingFacility').insertOrUpdate(evseChargingFacilities) : null,
      evseChargingModes.length ? trx('EVSEChargingMode').insertOrUpdate(evseChargingModes) : null,
      evsePaymentOptions.length ? trx('EVSEPaymentOption').insertOrUpdate(evsePaymentOptions) : null,
      evsePlugs.length ? trx('EVSEPlug').insertOrUpdate(evsePlugs) : null,
      evseValueAddedServices.length ? trx('EVSEValueAddedService').insertOrUpdate(evseValueAddedServices) : null
    ])
  }

  /**
   * Maps the evse data records to the database model
   */
  private mapEvseDataToEvses(evseData: IEvseDataRecord[]): IEVSE[] {

    return evseData.map(evseData => ({
      id: evseData.EvseId,
      country: evseData.Address.Country,
      city: evseData.Address.City,
      street: evseData.Address.Street,
      postalCode: evseData.Address.PostalCode,
      houseNum: evseData.Address.HouseNum,
      floor: evseData.Address.Floor,
      region: evseData.Address.Region,
      timezone: evseData.Address.TimeZone,
      longitude: this.dataImportHelper.getLongitudeByEvseDataRecord(evseData.GeoCoordinates),
      latitude: this.dataImportHelper.getLatitudeByEvseDataRecord(evseData.GeoCoordinates),
      entranceLongitude: this.dataImportHelper.getLongitudeByEvseDataRecord(evseData.GeoChargingPointEntrance),
      entranceLatitude: this.dataImportHelper.getLatitudeByEvseDataRecord(evseData.GeoChargingPointEntrance),
      maxCapacity: evseData.MaxCapacity,
      accessibilityId: this.dataImportHelper.getEnumIdByString(this.accessibilities.models, evseData.Accessibility),
      operatorId: evseData.OperatorId,
      chargingStationId: evseData.ChargingStationId,
      chargingStationName: evseData.ChargingStationName,
      lastUpdate: evseData.attributes.lastUpdate,
      additionalInfo: evseData.AdditionalInfo,
      isOpen24Hours: this.dataImportHelper.getIntByBooleanString(evseData.IsOpen24Hours),
      openingTime: evseData.OpeningTime,
      hubOperatorId: evseData.HubOperatorID,
      clearinghouseId: evseData.ClearinghouseID,
      isHubjectCompatible: this.dataImportHelper.getIntByBooleanString(evseData.IsHubjectCompatible),
      dynamicInfoAvailable: evseData.DynamicInfoAvailable,
      hotlinePhoneNum: evseData.HotlinePhoneNum
    }))
      ;
  }

  /**
   * Retrieves the evse data records from the operator data and
   * stores the corresponding operator id to the evse data record object.
   */
  private retrieveEvseDataFromOperatorData(operatorData: IOperatorEvseData[]): IEvseDataRecord[] {

    let evseData: IEvseDataRecord[] = [];

    operatorData.forEach(operatorData => {

      evseData = evseData.concat(this.dataImportHelper.getArrayByValue_Array(operatorData.EvseDataRecord).map(evseData => {

        // store operator id to evse data
        evseData.OperatorId = operatorData.OperatorID;

        return evseData;
      }));
    });

    return evseData;
  }

  /**
   * An EVSE record can be related to a sub operator. This relation
   * can only be detected by comparing the evse id with its operator
   * id. If the evse id does not consist of the operator id, the
   * evse belongs to an sub operator, which also can be calculated
   * by the evse id. For this created sup operator, an entry will
   * be created and stored into the database. The operator id of
   * the evse will be adjusted with the sub operator id. So that
   * the evse will only be directly connected with its sub operator.
   */
  private processPossibleSubOperatorsFromEvseData(evseData: IEvseDataRecord[], trx) {

    const OPERATOR_ID_REGEX = /([A-Za-z]{2}\*?[A-Za-z0-9]{3})|(\+?[0-9]{1,3}\*[0-9]{3})/;
    const subOperators: IOperator[] = [];

    evseData.forEach(evseData => {

      // Calculate possible sup operator through evse id:
      let possibleSupOperatorId = OPERATOR_ID_REGEX.exec(evseData.EvseId)[0];

      // If the calculated operator id differs from the EVSE data
      // operator id property, this EVSE should be connected to this
      // sub operator
      if (evseData.OperatorId !== possibleSupOperatorId) {

        // create sub operator
        subOperators.push({
          id: possibleSupOperatorId,
          name: null,
          parentId: evseData.OperatorId
        });

        // adjust operator id of current EVSE data
        evseData.OperatorId = possibleSupOperatorId;
      }

    });

    return trx('Operator')
      .insertOrUpdate(subOperators)
      ;
  }

}
