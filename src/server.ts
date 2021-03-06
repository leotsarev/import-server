import * as express from "express";
import { Observable, BehaviorSubject  } from 'rxjs/Rx';
import * as moment from "moment";
import * as winston from 'winston';
import * as PouchDB from 'pouchdb';
import * as pouchDBFind from 'pouchdb-find';

import { ImportStats, ImportRunStats } from './stats';
import { config } from './config';
import { JoinData, JoinImporter, JoinCharacter,JoinCharacterDetail, JoinMetadata } from './join-importer';
import { TempDbWriter} from './tempdb-writer';
import { AliceExporter } from './alice-exporter';
import { CatalogsLoader } from './catalogs-loader';
import { ModelRefresher } from './model-refresher';
import { MailProvision } from './mail-provision';
import { processCliParams } from './cli-params';
import { EconomyProvision } from './econ-provioning';

PouchDB.plugin(pouchDBFind);

class ModelImportData{
    importer:JoinImporter = new JoinImporter();
    cacheWriter: TempDbWriter = new TempDbWriter();
    catalogsLoader: CatalogsLoader = new CatalogsLoader();
    modelRefresher: ModelRefresher = new ModelRefresher();
    mailProvision: MailProvision = new MailProvision(); 
    economyProvision: EconomyProvision = new EconomyProvision(); 

    currentStats = new ImportRunStats();

    lastRefreshTime = moment([1900,0,1]);

    charList:JoinCharacter[] = [];
    charDetails:JoinCharacterDetail[] = [];

    importCouter: number = 0;

    constructor() {} 
}



const params = processCliParams();

if(!params){
     process.exit(0);
}

winston.info("Run CLI parameters: " + JSON.stringify(params));

//start logging
configureLogger();

//Reenter flag
let isImportRunning = false;

//Statisticts
let stats = new ImportStats();

if(params.export || params.import || params.id || params.test || params.list || params.refresh || params.mail || params.econ){
    let _id = params.id? params.id : 0;
    let since = params.since? moment.utc(params.since, "YYYY-MM-DDTHH:mm") : null;
    
    importAndCreate(_id, (params.import == true), (params.export==true), (params.list==true), 
                            false, (params.refresh==true), (params.mail==true), (params.econ==true), since)
    .subscribe( (data:string) => {},
                (error:any) => {
                    process.exit(1);
                },
                () => {
                    winston.info("Finished!");
                    process.exit(0);
                }
    );
}else if(params.server){
    winston.info(`Start HTTP-server on port: ${config.port} and run import loop`);

    var app = express();
    app.listen(config.port);

    app.get('/', function (req, res) {
        res.send(stats.toString());
    })

    Observable.timer(0, config.importInterval).
        flatMap( () => importAndCreate() )
        .subscribe( (data:string) => {},
            (error:any) => {
                process.exit(1);
            },
            () => {
                winston.info("Finished!");
                process.exit(0);
            }
        );
}

/**
 * Предвартельные операции для импорта (токен, заливка метаданных, каталоги и т.д)
 */
function prepareForImport(data:ModelImportData):Observable<ModelImportData> {

    return Observable.fromPromise(data.cacheWriter.getLastStats())
            .map( (loadedStats) => {
                data.lastRefreshTime = loadedStats.importTime;
                return data;
            })
            .flatMap( () => data.importer.init() )
            .flatMap( () => data.importer.getMetadata() )
            .do( () => winston.info(`Received metadata!`) )
            .flatMap( () => data.cacheWriter.saveMetadata(data.importer.metadata) )
            .do( () => winston.info(`Save metadata to cache!`) )
            .flatMap( () => data.catalogsLoader.load() )
            .do( () => {
                Object.keys(data.catalogsLoader.catalogs).forEach( (name) => {
                    winston.info(`Loaded catalog: ${name}, elements: ${data.catalogsLoader.catalogs[name].length}`);  
                })
            })
            .flatMap( () => Observable.from([data]) );                           
}

/**
 * Получение списка обновленных персонажей (выполняется с уже подготовленной ModelImportData)
 */
function loadCharacterListFomJoin(data: ModelImportData): Observable<ModelImportData> {
    return Observable.fromPromise( 
                data.importer.getCharacterList(data.lastRefreshTime.subtract(5,"minutes"))
                .then( ( c:JoinCharacter[] ) => {
                            data.charList = c;
                            return data;   
                 })
            );
}


/**
 * Получение списка персонажей в кеше (выполняется с уже подготовленной ModelImportData)
 */
function loadCharacterListFromCache(data: ModelImportData): Observable<ModelImportData> {
    return Observable.fromPromise( 
                data.cacheWriter.getCacheCharactersList()
                .then( ( c:JoinCharacter[] ) => {
                            winston.info("Debug: " + JSON.stringify(c));
                            data.charList = c;
                            return data;   
                 })
            );
}

/**
 * Сохранение данных о персонаже из Join в кеш на CouchDB
 */
function saveCharacterToCache(char: JoinCharacterDetail, data: ModelImportData): Observable<JoinCharacterDetail> {
    return Observable.fromPromise( data.cacheWriter.saveCharacter(char) )
            .do( (c:any) => winston.info(`Character id: ${c.id} saved to cache`) )
            .map( () => char)
}

/**
 * Создание модели персонажа по данным из Join и экспорт в Model-базу
 */
function exportCharacterModel(char: JoinCharacterDetail, data: ModelImportData, exportModel: boolean = true): Observable<JoinCharacterDetail> {
    let model = new AliceExporter(char, data.importer.metadata, data.catalogsLoader, true);
    char.model = model.model;

    if(exportModel){
        return Observable.fromPromise(model.export())
                .map( (c:any) => { 
                        if(c) {
                            winston.info( `Exported model and account for character ${char._id}, results: ${JSON.stringify(c)}`);
                        }else{
                            winston.info( `Model and account for character ${char._id} not exported: model alredy IN THE GAME` );
                            char.finalInGame = true;    //Отметить что эта модель дальше не надо обрабатывать
                        }

                        return char;
                });
    }else{
        return Observable.from([char]);
    }
}          
        
/**
 * Посылка события Refresh-модели
 */
function sendModelRefresh(char: JoinCharacterDetail, data: ModelImportData): Observable<JoinCharacterDetail> {
    return Observable.fromPromise(data.modelRefresher.sentRefreshEvent(char))
            .map( (c:any) => { 
                    winston.info( `Refresh event sent to model for character id = ${char._id}: ` + JSON.stringify(c) );
                    return char;
            });
}

/**
 * Регистрация аккаунта в экономике
 */
function registerEconAccount(char: JoinCharacterDetail, data: ModelImportData): Observable<JoinCharacterDetail> {
    return Observable.fromPromise(data.economyProvision.regiterAccount(char))
            .map( (c:any) => { 
                    winston.info( `Registered economy account for character id = ${char._id}: ` + JSON.stringify(c) );
                    return char;
            });
}

        
/**
 * Создание e-mail адресов и учеток для всех персонажей
 */
function provisionMailAddreses(data: ModelImportData): Promise<any> {
    //winston.info(`provisionMailAddreses: ` + data.charDetails.map(c=>c._id).join(','));
    return data.mailProvision.createEmails(data.charDetails).then( c => {        
        winston.info( `Reques for mail creation was sent for: ${data.charDetails.map(c=>c._id).join(',')}, result: ${JSON.stringify(c)}`);
        return c;
    });
}


/**
 * Получение потока данных персонажей (выполняется с уже подготовленной ModelImportData)
 */
function loadCharactersFromJoin(data: ModelImportData): Observable<JoinCharacterDetail>{
    let bufferCounter = 0;
     winston.info("Load characters from JoinRPG");

    return Observable.from(data.charList)
            .bufferCount(config.importBurstSize)        //Порезать на группы по 20
        
            //Добавить задержку между обработкой записей
            .flatMap( c => Observable.from([c]).delay(config.importBurstDelay), 1 )

            .mergeMap( (cl:JoinCharacter[]) => {        //Каждую группу преобразовать в один общий Promise, ждущий все запросы в группе
                winston.info( `##=====================================\n` +
                             `## Process buffer ${bufferCounter}, size=${config.importBurstSize}: ${cl.map(d => d.CharacterId).join(',')}` +
                             `\n##=====================================`);
                bufferCounter++;

                let promiseArr: Promise<JoinCharacterDetail>[] = [];
                cl.forEach( c => promiseArr.push(data.importer.getCharacter(c.CharacterLink)) );

                return Promise.all(promiseArr);
            }, 1)
            .retry(3)
            
            .mergeMap( (cl:JoinCharacterDetail[]) => Observable.from(cl) ) //Полученные данные группы разбить на отдельные элементы для обработки
            .do( (c:JoinCharacterDetail) => winston.info(`Imported character: ${c.CharacterId}`) )  //Написать в лог
}

/**
 * Получение потока данных персонажей из кэша (выполняется с уже подготовленной ModelImportData)
 */
function loadCharactersFromCache(data: ModelImportData): Observable<JoinCharacterDetail>{
    let bufferCounter = 0;
    winston.info("Load characters from CouchDB cache");
    
    return Observable.from(data.charList)
            .bufferCount(config.importBurstSize)        //Порезать на группы по 20
            .mergeMap( (cl:JoinCharacter[]) => {        //Каждую группу преобразовать в один общий Promise, ждущий все запросы в группе
                winston.info( `##=====================================\n` +
                             `## Process buffer ${bufferCounter}, size=${config.importBurstSize}: ${cl.map(d => d.CharacterId).join(',')}` +
                             `\n##=====================================`);
                bufferCounter++;

                let promiseArr: Promise<JoinCharacterDetail>[] = [];
                cl.forEach( c => promiseArr.push(data.cacheWriter.getCacheCharacter(c.CharacterId.toString())) );

                return Promise.all(promiseArr);
            }, 1)
            .retry(3)
            
            .mergeMap( (cl:JoinCharacterDetail[]) => Observable.from(cl) ) //Полученные данные группы разбить на отдельные элементы для обработки
            .do( (c:JoinCharacterDetail) => winston.info(`Imported character: ${c.CharacterId}`) )  //Написать в лог
}

/**
 *  Функция для импорта данных из Join, записи в кеш CouchDB, создания и экспорта моделей 
 *  (т.е. вся цепочка)
 */
function importAndCreate(   id:number = 0,
                            importJoin:boolean = true, 
                            exportModel:boolean = true,
                            onlyList:boolean = false, 
                            updateStats:boolean = true,
                            refreshModel:boolean = false,
                            mailProvision:boolean = true,
                            econProvision:boolean = true,
                            updatedSince?: moment.Moment ): Observable<string> {

    
    let sinceText = updatedSince? updatedSince.format("DD-MM-YYYY HH:mm:SS") : "";

    winston.info(`Run import sequence with: id=${id}, import=${importJoin}, export=${exportModel}, ` +
                  `onlyList=${onlyList}, updateStats=${updateStats}, refresh=${refreshModel}, mailProvision=${mailProvision}, ` + 
                   `econProvision=${econProvision}, + updateSince=${sinceText}` )


    //Объект с рабочими данными при импорте - экспорте
    let workData = new ModelImportData();

    if(isImportRunning) {
        winston.info("Import session in progress.. return and wait to next try");
        return Observable.from([]);
    }

    isImportRunning = true;

    let returnSubject = new BehaviorSubject("start"); 

    prepareForImport(workData)
    //Установить дату с которой загружать персонажей (если задано)
        .map( (data) => { 
            if(updatedSince){ data.lastRefreshTime = updatedSince; }
            winston.info("Using update since time: " +  data.lastRefreshTime.format("DD-MM-YYYY HH:mm:SS")) 
            return data;
        })

    //Загрузить список персонажей (Join или кэш), если не задан ID
        .flatMap( (data:ModelImportData) => {
                if(id){
                    data.charList.push( JoinImporter.createJoinCharacter(id) );
                    return Observable.from([data]);
                }else if(importJoin){
                    return loadCharacterListFomJoin(data); 
                }else{
                    return loadCharacterListFromCache(data);
                }
        })

    //Запись в лог
        .do( data => winston.info(`Received character list: ${data.charList.length} characters`) )

    //Если это только запрос списка - закончить
        .filter( data => !onlyList ) 

    //Загрузить данные из Join или из кеша
        .flatMap( (data:ModelImportData) => importJoin ? loadCharactersFromJoin(data) : loadCharactersFromCache(data) )

    //Добавить задержку между обработкой записей
        .flatMap( c => Observable.from([c]).delay(config.importDelay), 1 )

    //Сохранить данные в кеш (если надо)
        .flatMap( c => importJoin ? saveCharacterToCache(c, workData) : Observable.from([c]) )

    //Экспортировать модель в БД (если надо)
        .flatMap( c  =>  exportCharacterModel(c, workData, exportModel) )

    //Если персонаж "В игре" остановить дальнейшую обработку
        .filter( c => (!c.finalInGame) )

    //Сохранить данные по персонажу в общий список
        .do( c => workData.charDetails.push(c) )

    //Послать модели Refresh соообщение для создания Work и View-моделей
        .flatMap( c => refreshModel ? sendModelRefresh(c, workData) : Observable.from([c]) )

    //Отправить запрос на регистрацию аккаунта в экономике
        .flatMap( c => econProvision ? registerEconAccount(c, workData)  : Observable.from([c]) )

    //Посчитать статистику
        .do( () => workData.importCouter++ )

    //Собрать из всех обработанных данных всех персонажей общий массив и передать дальше как один элемент
        .toArray()
    //Отправить запрос на создание почтовых ящиков для всхе персонажей
        .filter( () => workData.charDetails.length > 0 )
        .flatMap( c => mailProvision ? Observable.fromPromise(provisionMailAddreses(workData)) : Observable.from([c]) )
        .subscribe( ()=> {},
            (error)=>{
                winston.info( "Error in pipe: " + JSON.stringify(error) );  
                isImportRunning = false;
            },
            () => {
                isImportRunning = false;

                if(updateStats){
                    workData.cacheWriter.saveLastStats( new ImportRunStats(moment.utc()) );
                }

                winston.info(`Import sequence completed. Imported ${workData.importCouter} models!`);

                returnSubject.complete();
            }
        )

    return returnSubject;
}

function configureLogger(){
    winston.add(winston.transports.File, { 
                filename: config.logFileName,
                level: 'debug',
                json: false
            });

    winston.handleExceptions(new winston.transports.File({
                 filename: 'path/to/exceptions.log',
                handleExceptions: true,
                humanReadableUnhandledException: true,
                level: 'debug',
                json: false
            }));
}