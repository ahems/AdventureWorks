/*============================================================================
  File:     instawdb.sql

  Summary:  Creates the AdventureWorks sample database. Run this on
  any version of SQL Server (2008R2 or later) to get AdventureWorks for your
  current version.  

  Date:     October 26, 2017
  Updated:  October 26, 2017

------------------------------------------------------------------------------
  This file is part of the Microsoft SQL Server Code Samples.

  Copyright (C) Microsoft Corporation.  All rights reserved.

  This source code is intended only as a supplement to Microsoft
  Development Tools and/or on-line documentation.  See these other
  materials for detailed information regarding Microsoft code samples.

  All data in this database is ficticious.
  
  THIS CODE AND INFORMATION ARE PROVIDED "AS IS" WITHOUT WARRANTY OF ANY
  KIND, EITHER EXPRESSED OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE
  IMPLIED WARRANTIES OF MERCHANTABILITY AND/OR FITNESS FOR A
  PARTICULAR PURPOSE.
============================================================================*/

/*
 * HOW TO RUN THIS SCRIPT:
 *
 * 1. Enable full-text search on your SQL Server instance. 
 *
 * 2. Open the script inside SQL Server Management Studio and enable SQLCMD mode. 
 *    This option is in the Query menu.
 *
 * 3. Copy this script and the install files to C:\Samples\AdventureWorks, or
 *    set the following environment variable to your own data path.
 */
 :setvar SqlSamplesSourceDataPath "C:\Samples\AdventureWorks\"

/*
 * 4. Append the SQL Server version number to database name if you want to
 *    differentiate it from other installs of AdventureWorks.
 */

:setvar DatabaseName "AdventureWorks"

/* Execute the script
 */

SET NOCOUNT OFF;
GO

PRINT CONVERT(varchar(1000), @@VERSION);
GO

PRINT '';
PRINT 'Started - ' + CONVERT(varchar, GETDATE(), 121);
GO

-- Database should already exist in Azure SQL DB
-- Schema objects will be created in the current database
PRINT '';
PRINT '*** Creating AdventureWorks Schema Objects';
GO

-- Database-level DDL triggers not supported in Azure SQL DB
-- DatabaseLog table and ddlDatabaseTriggerLog removed

-- ****************************************
-- Drop dependent views before table recreation
-- ****************************************
-- The vProductAndDescription view references Product, ProductModel, 
-- ProductDescription, and ProductModelProductDescriptionCulture tables.
-- It must be dropped first to allow these tables to be recreated.
-- The view will be recreated by AdventureWorks-AI.sql after data loading.
PRINT '';
PRINT '*** Dropping dependent views for table recreation';
GO

IF EXISTS (SELECT 1 FROM sys.views WHERE object_id = OBJECT_ID(N'[Production].[vProductAndDescription]'))
BEGIN
    DROP VIEW [Production].[vProductAndDescription];
    PRINT 'Dropped view Production.vProductAndDescription';
END;
GO

-- ****************************************
-- Create Error Log objects
-- ****************************************
PRINT '';
PRINT '*** Creating Error Log objects';
GO

-- Create table to store error information
DROP TABLE IF EXISTS [dbo].[ErrorLog];
GO

CREATE TABLE [dbo].[ErrorLog](
    [ErrorLogID] [int] IDENTITY (1, 1) NOT NULL,
    [ErrorTime] [datetime] NOT NULL CONSTRAINT [DF_ErrorLog_ErrorTime] DEFAULT (GETDATE()),
    [UserName] [sysname] NOT NULL, 
    [ErrorNumber] [int] NOT NULL, 
    [ErrorSeverity] [int] NULL, 
    [ErrorState] [int] NULL, 
    [ErrorProcedure] [nvarchar](126) NULL, 
    [ErrorLine] [int] NULL, 
    [ErrorMessage] [nvarchar](4000) NOT NULL
) ON [PRIMARY];
GO

ALTER TABLE [dbo].[ErrorLog] WITH CHECK ADD 
    CONSTRAINT [PK_ErrorLog_ErrorLogID] PRIMARY KEY CLUSTERED 
    (
        [ErrorLogID]
    )  ON [PRIMARY];
GO

-- uspPrintError prints error information about the error that caused 
-- execution to jump to the CATCH block of a TRY...CATCH construct. 
-- Should be executed from within the scope of a CATCH block otherwise 
-- it will return without printing any error information.
DROP PROCEDURE IF EXISTS [dbo].[uspPrintError];
GO

CREATE PROCEDURE [dbo].[uspPrintError] 
AS
BEGIN
    SET NOCOUNT ON;

    -- Print error information. 
    PRINT 'Error ' + CONVERT(varchar(50), ERROR_NUMBER()) +
          ', Severity ' + CONVERT(varchar(5), ERROR_SEVERITY()) +
          ', State ' + CONVERT(varchar(5), ERROR_STATE()) + 
          ', Procedure ' + ISNULL(ERROR_PROCEDURE(), '-') + 
          ', Line ' + CONVERT(varchar(5), ERROR_LINE());
    PRINT ERROR_MESSAGE();
END;
GO

-- uspLogError logs error information in the ErrorLog table about the 
-- error that caused execution to jump to the CATCH block of a 
-- TRY...CATCH construct. This should be executed from within the scope 
-- of a CATCH block otherwise it will return without inserting error 
-- information. 
DROP PROCEDURE IF EXISTS [dbo].[uspLogError];
GO

CREATE PROCEDURE [dbo].[uspLogError] 
    @ErrorLogID [int] = 0 OUTPUT -- contains the ErrorLogID of the row inserted
AS                               -- by uspLogError in the ErrorLog table
BEGIN
    SET NOCOUNT ON;

    -- Output parameter value of 0 indicates that error 
    -- information was not logged
    SET @ErrorLogID = 0;

    BEGIN TRY
        -- Return if there is no error information to log
        IF ERROR_NUMBER() IS NULL
            RETURN;

        -- Return if inside an uncommittable transaction.
        -- Data insertion/modification is not allowed when 
        -- a transaction is in an uncommittable state.
        IF XACT_STATE() = -1
        BEGIN
            PRINT 'Cannot log error since the current transaction is in an uncommittable state. ' 
                + 'Rollback the transaction before executing uspLogError in order to successfully log error information.';
            RETURN;
        END

        INSERT [dbo].[ErrorLog] 
            (
            [UserName], 
            [ErrorNumber], 
            [ErrorSeverity], 
            [ErrorState], 
            [ErrorProcedure], 
            [ErrorLine], 
            [ErrorMessage]
            ) 
        VALUES 
            (
            CONVERT(sysname, CURRENT_USER), 
            ERROR_NUMBER(),
            ERROR_SEVERITY(),
            ERROR_STATE(),
            ERROR_PROCEDURE(),
            ERROR_LINE(),
            ERROR_MESSAGE()
            );

        -- Pass back the ErrorLogID of the row inserted
        SET @ErrorLogID = @@IDENTITY;
    END TRY
    BEGIN CATCH
        PRINT 'An error occurred in stored procedure uspLogError: ';
        EXECUTE [dbo].[uspPrintError];
        RETURN -1;
    END CATCH
END;
GO


-- ****************************************
-- Create Data Types
-- ****************************************
PRINT '';
PRINT '*** Creating Data Types';
GO

-- Note: Cannot drop types while tables reference them
-- DROP TYPE statements removed for idempotency
-- Types will only be created if they don't exist

IF NOT EXISTS (SELECT * FROM sys.types WHERE name = 'AccountNumber' AND is_user_defined = 1)
    CREATE TYPE [AccountNumber] FROM nvarchar(15) NULL;
GO

IF NOT EXISTS (SELECT * FROM sys.types WHERE name = 'Flag' AND is_user_defined = 1)
    CREATE TYPE [Flag] FROM bit NOT NULL;
GO

IF NOT EXISTS (SELECT * FROM sys.types WHERE name = 'NameStyle' AND is_user_defined = 1)
    CREATE TYPE [NameStyle] FROM bit NOT NULL;
GO

IF NOT EXISTS (SELECT * FROM sys.types WHERE name = 'Name' AND is_user_defined = 1)
    CREATE TYPE [Name] FROM nvarchar(50) NULL;
GO

IF NOT EXISTS (SELECT * FROM sys.types WHERE name = 'OrderNumber' AND is_user_defined = 1)
    CREATE TYPE [OrderNumber] FROM nvarchar(25) NULL;
GO

IF NOT EXISTS (SELECT * FROM sys.types WHERE name = 'Phone' AND is_user_defined = 1)
    CREATE TYPE [Phone] FROM nvarchar(25) NULL;
GO


-- ******************************************************
-- Add pre-table database functions.
-- ******************************************************
PRINT '';
PRINT '*** Creating Pre-Table Database Functions';
GO

-- Note: Cannot drop while referenced by Customer table
-- Function must exist before creating tables that reference it
IF NOT EXISTS (SELECT * FROM sys.objects WHERE object_id = OBJECT_ID(N'[dbo].[ufnLeadingZeros]') AND type IN ('FN', 'IF', 'TF'))
BEGIN
    EXEC sp_executesql N'
    CREATE FUNCTION [dbo].[ufnLeadingZeros](
        @Value int
    ) 
    RETURNS varchar(8) 
    WITH SCHEMABINDING 
    AS 
    BEGIN
        DECLARE @ReturnValue varchar(8);

        SET @ReturnValue = CONVERT(varchar(8), @Value);
        SET @ReturnValue = REPLICATE(''0'', 8 - DATALENGTH(@ReturnValue)) + @ReturnValue;

        RETURN (@ReturnValue);
    END;
    ';
END;
GO

-- Note: Cannot drop schemas while objects reference them
-- Schemas are created only if they don't exist

IF NOT EXISTS (SELECT * FROM sys.schemas WHERE name = 'HumanResources')
    EXEC('CREATE SCHEMA [HumanResources] AUTHORIZATION [dbo]');
GO

IF NOT EXISTS (SELECT * FROM sys.schemas WHERE name = 'Person')
    EXEC('CREATE SCHEMA [Person] AUTHORIZATION [dbo]');
GO

IF NOT EXISTS (SELECT * FROM sys.schemas WHERE name = 'Production')
    EXEC('CREATE SCHEMA [Production] AUTHORIZATION [dbo]');
GO

IF NOT EXISTS (SELECT * FROM sys.schemas WHERE name = 'Purchasing')
    EXEC('CREATE SCHEMA [Purchasing] AUTHORIZATION [dbo]');
GO

IF NOT EXISTS (SELECT * FROM sys.schemas WHERE name = 'Sales')
    EXEC('CREATE SCHEMA [Sales] AUTHORIZATION [dbo]');
GO


-- ****************************************
-- Create XML schemas
-- ****************************************
PRINT '';
PRINT '*** Creating XML Schemas';
GO

-- Create AdditionalContactInfo schema
PRINT '';
PRINT 'Create AdditionalContactInfo schema';
GO

-- Note: Cannot drop while referenced by Person.Person table
-- Skipping drop to maintain idempotency
IF NOT EXISTS (SELECT * FROM sys.xml_schema_collections WHERE name = 'AdditionalContactInfoSchemaCollection' AND schema_id = SCHEMA_ID('Person'))
BEGIN
CREATE XML SCHEMA COLLECTION [Person].[AdditionalContactInfoSchemaCollection] AS 
'<?xml version="1.0" encoding="UTF-8"?>
<xsd:schema targetNamespace="http://schemas.microsoft.com/sqlserver/2004/07/adventure-works/ContactInfo" 
    xmlns="http://schemas.microsoft.com/sqlserver/2004/07/adventure-works/ContactInfo" 
    elementFormDefault="qualified"
    xmlns:xsd="http://www.w3.org/2001/XMLSchema" >
    <!-- the following imports are not needed. They simply provide readability -->

    <xsd:import 
        namespace="http://schemas.microsoft.com/sqlserver/2004/07/adventure-works/ContactRecord" />

    <xsd:import 
        namespace="http://schemas.microsoft.com/sqlserver/2004/07/adventure-works/ContactTypes" />

    <xsd:element name="AdditionalContactInfo" >
        <xsd:complexType mixed="true" >
            <xsd:sequence>
                <xsd:any processContents="strict" 
                    namespace="http://schemas.microsoft.com/sqlserver/2004/07/adventure-works/ContactRecord 
                        http://schemas.microsoft.com/sqlserver/2004/07/adventure-works/ContactTypes"
                        minOccurs="0" maxOccurs="unbounded" />
            </xsd:sequence>
        </xsd:complexType>
    </xsd:element>
</xsd:schema>';
END;
GO

-- Add ContactRecord namespace (only if not already present)
IF NOT EXISTS (SELECT 1 FROM sys.xml_schema_namespaces WHERE name = 'http://schemas.microsoft.com/sqlserver/2004/07/adventure-works/ContactRecord')
BEGIN
    ALTER XML SCHEMA COLLECTION [Person].[AdditionalContactInfoSchemaCollection] ADD 
    '<?xml version="1.0" encoding="UTF-8"?>
    <xsd:schema targetNamespace="http://schemas.microsoft.com/sqlserver/2004/07/adventure-works/ContactRecord"
    elementFormDefault="qualified"
    xmlns="http://schemas.microsoft.com/sqlserver/2004/07/adventure-works/ContactRecord"
    xmlns:xsd="http://www.w3.org/2001/XMLSchema" >

    <xsd:element name="ContactRecord" >
        <xsd:complexType mixed="true" >
            <xsd:choice minOccurs="0" maxOccurs="unbounded" >
                <xsd:any processContents="strict"  
                    namespace="http://schemas.microsoft.com/sqlserver/2004/07/adventure-works/ContactTypes" />
            </xsd:choice>
            <xsd:attribute name="date" type="xsd:date" />
        </xsd:complexType>
    </xsd:element>
    </xsd:schema>';
END;
GO

-- Add ContactTypes namespace (only if not already present)
IF NOT EXISTS (SELECT 1 FROM sys.xml_schema_namespaces WHERE name = 'http://schemas.microsoft.com/sqlserver/2004/07/adventure-works/ContactTypes')
BEGIN
    ALTER XML SCHEMA COLLECTION [Person].[AdditionalContactInfoSchemaCollection] ADD 
    '<?xml version="1.0" encoding="UTF-8"?>
    <xsd:schema targetNamespace="http://schemas.microsoft.com/sqlserver/2004/07/adventure-works/ContactTypes"
    xmlns="http://schemas.microsoft.com/sqlserver/2004/07/adventure-works/ContactTypes" 
    elementFormDefault="qualified"
    xmlns:xsd="http://www.w3.org/2001/XMLSchema" >

    <xsd:complexType name="specialInstructionsType" mixed="true">
        <xsd:sequence>
            <xsd:any processContents="strict" 
                namespace = "##targetNamespace"
                minOccurs="0" maxOccurs="unbounded" />
        </xsd:sequence>
    </xsd:complexType>

    <xsd:complexType name="phoneNumberType">
        <xsd:sequence>
            <xsd:element name="number" >
                <xsd:simpleType>
                    <xsd:restriction base="xsd:string">
                        <xsd:pattern value="[0-9\(\)\-]*"/>
                    </xsd:restriction>
                </xsd:simpleType>
            </xsd:element>
            <xsd:element name="SpecialInstructions" minOccurs="0" type="specialInstructionsType" />
        </xsd:sequence>
    </xsd:complexType>

    <xsd:complexType name="eMailType">
        <xsd:sequence>
            <xsd:element name="eMailAddress" type="xsd:string" />
            <xsd:element name="SpecialInstructions" minOccurs="0" type="specialInstructionsType" />
        </xsd:sequence>
    </xsd:complexType>

    <xsd:complexType name="addressType">
        <xsd:sequence>
            <xsd:element name="Street" type="xsd:string" minOccurs="1" maxOccurs="2" />
            <xsd:element name="City" type="xsd:string" minOccurs="1" maxOccurs="1" />
            <xsd:element name="StateProvince" type="xsd:string" minOccurs="1" maxOccurs="1" />
            <xsd:element name="PostalCode" type="xsd:string" minOccurs="0" maxOccurs="1" />
            <xsd:element name="CountryRegion" type="xsd:string" minOccurs="1" maxOccurs="1" />
            <xsd:element name="SpecialInstructions" type="specialInstructionsType" minOccurs="0"/>
        </xsd:sequence>
    </xsd:complexType>

    <xsd:element name="telephoneNumber"            type="phoneNumberType" />
    <xsd:element name="mobile"                     type="phoneNumberType" />
    <xsd:element name="pager"                      type="phoneNumberType" />
    <xsd:element name="facsimileTelephoneNumber"   type="phoneNumberType" />
    <xsd:element name="telexNumber"                type="phoneNumberType" />
    <xsd:element name="internationaliSDNNumber"    type="phoneNumberType" />
    <xsd:element name="eMail"                      type="eMailType" />
    <xsd:element name="homePostalAddress"          type="addressType" />
    <xsd:element name="physicalDeliveryOfficeName" type="addressType" />
    <xsd:element name="registeredAddress"          type="addressType" /> 
    </xsd:schema>';
END;
GO

-- Create Individual survey schema.
PRINT '';
PRINT 'Create Individual survey schema';
GO

-- Note: Cannot drop while referenced by Person.Person table
IF NOT EXISTS (SELECT * FROM sys.xml_schema_collections WHERE name = 'IndividualSurveySchemaCollection' AND schema_id = SCHEMA_ID('Person'))
BEGIN
CREATE XML SCHEMA COLLECTION [Person].[IndividualSurveySchemaCollection] AS 
'<?xml version="1.0" encoding="UTF-8"?>
<xsd:schema targetNamespace="http://schemas.microsoft.com/sqlserver/2004/07/adventure-works/IndividualSurvey" 
    xmlns="http://schemas.microsoft.com/sqlserver/2004/07/adventure-works/IndividualSurvey"
    elementFormDefault="qualified"
    xmlns:xsd="http://www.w3.org/2001/XMLSchema" >

    <xsd:simpleType name="SalaryType">
        <xsd:restriction base="xsd:string">
            <xsd:enumeration value="0-25000" />
            <xsd:enumeration value="25001-50000" />
            <xsd:enumeration value="50001-75000" />
            <xsd:enumeration value="75001-100000" />
            <xsd:enumeration value="greater than 100000" />
        </xsd:restriction>
    </xsd:simpleType>

    <xsd:simpleType name="MileRangeType">
        <xsd:restriction base="xsd:string">
            <xsd:enumeration value="0-1 Miles" />
            <xsd:enumeration value="1-2 Miles" />
            <xsd:enumeration value="2-5 Miles" />
            <xsd:enumeration value="5-10 Miles" />
            <xsd:enumeration value="10+ Miles" />
        </xsd:restriction>
    </xsd:simpleType>

    <xsd:element name="IndividualSurvey">
        <xsd:complexType>
            <xsd:sequence>
                <xsd:element name="TotalPurchaseYTD" type="xsd:decimal" minOccurs="0" maxOccurs="1" />
                <xsd:element name="DateFirstPurchase" type="xsd:date" minOccurs="0" maxOccurs="1" />
                <xsd:element name="BirthDate" type="xsd:date" minOccurs="0" maxOccurs="1" />
                <xsd:element name="MaritalStatus" type="xsd:string" minOccurs="0" maxOccurs="1" />
                <xsd:element name="YearlyIncome" type="SalaryType" minOccurs="0" maxOccurs="1" />
                <xsd:element name="Gender" type="xsd:string" minOccurs="0" maxOccurs="1" />
                <xsd:element name="TotalChildren" type="xsd:int" minOccurs="0" maxOccurs="1" />
                <xsd:element name="NumberChildrenAtHome" type="xsd:int" minOccurs="0" maxOccurs="1" />
                <xsd:element name="Education" type="xsd:string" minOccurs="0" maxOccurs="1" />
                <xsd:element name="Occupation" type="xsd:string" minOccurs="0" maxOccurs="1" />
                <xsd:element name="HomeOwnerFlag" type="xsd:string" minOccurs="0" maxOccurs="1" />
                <xsd:element name="NumberCarsOwned" type="xsd:int" minOccurs="0" maxOccurs="1" />
                <xsd:element name="Hobby" type="xsd:string" minOccurs="0" maxOccurs="unbounded" />
                <xsd:element name="CommuteDistance" type="MileRangeType" minOccurs="0" maxOccurs="1" />
                <xsd:element name="Comments" type="xsd:string" minOccurs="0" maxOccurs="1" />
            </xsd:sequence>
        </xsd:complexType>
    </xsd:element>
</xsd:schema>';
END;
GO

-- Create resume schema.
PRINT '';
PRINT 'Create Resume schema';
GO

-- Note: Cannot drop while referenced by HumanResources.JobCandidate table
IF NOT EXISTS (SELECT * FROM sys.xml_schema_collections WHERE name = 'HRResumeSchemaCollection' AND schema_id = SCHEMA_ID('HumanResources'))
BEGIN
CREATE XML SCHEMA COLLECTION [HumanResources].[HRResumeSchemaCollection] AS 
'<?xml version="1.0" encoding="UTF-8"?>
<xsd:schema targetNamespace="http://schemas.microsoft.com/sqlserver/2004/07/adventure-works/Resume" 
    xmlns="http://schemas.microsoft.com/sqlserver/2004/07/adventure-works/Resume" 
    xmlns:xsd="http://www.w3.org/2001/XMLSchema" 
    elementFormDefault="qualified" >

    <xsd:element name="Resume" type="ResumeType"/>
    <xsd:element name="Address" type="AddressType"/>
    <xsd:element name="Education" type="EducationType"/>
    <xsd:element name="Employment" type="EmploymentType"/>
    <xsd:element name="Location" type="LocationType"/>
    <xsd:element name="Name" type="NameType"/>
    <xsd:element name="Telephone" type="TelephoneType"/>

    <xsd:complexType name="ResumeType">
        <xsd:sequence>
            <xsd:element ref="Name"/>
            <xsd:element name="Skills" type="xsd:string" minOccurs="0"/>
            <xsd:element ref="Employment" maxOccurs="unbounded"/>
            <xsd:element ref="Education" maxOccurs="unbounded"/>
            <xsd:element ref="Address" maxOccurs="unbounded"/>
            <xsd:element ref="Telephone" minOccurs="0"/>
            <xsd:element name="EMail" type="xsd:string" minOccurs="0"/>
            <xsd:element name="WebSite" type="xsd:string" minOccurs="0"/>
        </xsd:sequence>
    </xsd:complexType>

    <xsd:complexType name="AddressType">
        <xsd:sequence>
            <xsd:element name="Addr.Type" type="xsd:string">
                <xsd:annotation>
                    <xsd:documentation>Home|Work|Permanent</xsd:documentation>
                </xsd:annotation>
            </xsd:element>
            <xsd:element name="Addr.OrgName" type="xsd:string" minOccurs="0"/>
            <xsd:element name="Addr.Street" type="xsd:string" maxOccurs="unbounded"/>
            <xsd:element name="Addr.Location">
                <xsd:complexType>
                    <xsd:sequence>
                        <xsd:element ref="Location"/>
                    </xsd:sequence>
                </xsd:complexType>
            </xsd:element>
            <xsd:element name="Addr.PostalCode" type="xsd:string"/>
            <xsd:element name="Addr.Telephone" minOccurs="0">
                <xsd:complexType>
                    <xsd:sequence>
                        <xsd:element ref="Telephone" maxOccurs="unbounded"/>
                    </xsd:sequence>
                </xsd:complexType>
            </xsd:element>
        </xsd:sequence>
    </xsd:complexType>

    <xsd:complexType name="EducationType">
        <xsd:sequence>
            <xsd:element name="Edu.Level" type="xsd:string">
                <xsd:annotation>
                    <xsd:documentation>High School|Associate|Bachelor|Master|Doctorate</xsd:documentation>
                </xsd:annotation>
            </xsd:element>
            <xsd:element name="Edu.StartDate" type="xsd:date"/>
            <xsd:element name="Edu.EndDate" type="xsd:date"/>
            <xsd:element name="Edu.Degree" type="xsd:string" minOccurs="0"/>
            <xsd:element name="Edu.Major" type="xsd:string" minOccurs="0"/>
            <xsd:element name="Edu.Minor" type="xsd:string" minOccurs="0"/>
            <xsd:element name="Edu.GPA" type="xsd:string" minOccurs="0"/>
            <xsd:element name="Edu.GPAAlternate" type="xsd:decimal" minOccurs="0">
                <xsd:annotation>
                    <xsd:documentation>In case the institution does not follow a GPA system</xsd:documentation>
                </xsd:annotation>
            </xsd:element>
            <xsd:element name="Edu.GPAScale" type="xsd:decimal" minOccurs="0"/>
            <xsd:element name="Edu.School" type="xsd:string" minOccurs="0"/>
            <xsd:element name="Edu.Location" minOccurs="0">
                <xsd:complexType>
                    <xsd:sequence>
                        <xsd:element ref="Location"/>
                    </xsd:sequence>
                </xsd:complexType>
            </xsd:element>
        </xsd:sequence>
    </xsd:complexType>

    <xsd:complexType name="EmploymentType">
        <xsd:sequence>
            <xsd:element name="Emp.StartDate" type="xsd:date" minOccurs="0"/>
            <xsd:element name="Emp.EndDate" type="xsd:date" minOccurs="0"/>
            <xsd:element name="Emp.OrgName" type="xsd:string"/>
            <xsd:element name="Emp.JobTitle" type="xsd:string"/>
            <xsd:element name="Emp.Responsibility" type="xsd:string"/>
            <xsd:element name="Emp.FunctionCategory" type="xsd:string" minOccurs="0"/>
            <xsd:element name="Emp.IndustryCategory" type="xsd:string" minOccurs="0"/>
            <xsd:element name="Emp.Location" minOccurs="0">
                <xsd:complexType>
                    <xsd:sequence>
                        <xsd:element ref="Location"/>
                    </xsd:sequence>
                </xsd:complexType>
            </xsd:element>
        </xsd:sequence>
    </xsd:complexType>

    <xsd:complexType name="LocationType">
        <xsd:sequence>
            <xsd:element name="Loc.CountryRegion" type="xsd:string">
                <xsd:annotation>
                    <xsd:documentation>ISO 3166 Country Code</xsd:documentation>
                </xsd:annotation>
            </xsd:element>
            <xsd:element name="Loc.State" type="xsd:string" minOccurs="0"/>
            <xsd:element name="Loc.City" type="xsd:string" minOccurs="0"/>
        </xsd:sequence>
    </xsd:complexType>

    <xsd:complexType name="NameType">
        <xsd:sequence>
            <xsd:element name="Name.Prefix" type="xsd:string" minOccurs="0"/>
            <xsd:element name="Name.First" type="xsd:string"/>
            <xsd:element name="Name.Middle" type="xsd:string" minOccurs="0"/>
            <xsd:element name="Name.Last" type="xsd:string"/>
            <xsd:element name="Name.Suffix" type="xsd:string" minOccurs="0"/>
        </xsd:sequence>
    </xsd:complexType>

    <xsd:complexType name="TelephoneType">
        <xsd:sequence>
            <xsd:element name="Tel.Type" minOccurs="0">
                <xsd:annotation>
                    <xsd:documentation>Voice|Fax|Pager</xsd:documentation>
                </xsd:annotation>
            </xsd:element>
            <xsd:element name="Tel.IntlCode" type="xsd:int" minOccurs="0"/>
            <xsd:element name="Tel.AreaCode" type="xsd:int" minOccurs="0"/>
            <xsd:element name="Tel.Number" type="xsd:string"/>
            <xsd:element name="Tel.Extension" type="xsd:int" minOccurs="0"/>
        </xsd:sequence>
    </xsd:complexType>
</xsd:schema>';
END;
GO

-- Create Product catalog description schema.
PRINT '';
PRINT 'Create Product catalog description schema';
GO

-- Note: Cannot drop while referenced by Production.ProductModel table
IF NOT EXISTS (SELECT * FROM sys.xml_schema_collections WHERE name = 'ProductDescriptionSchemaCollection' AND schema_id = SCHEMA_ID('Production'))
BEGIN
CREATE XML SCHEMA COLLECTION [Production].[ProductDescriptionSchemaCollection] AS 
'<xsd:schema targetNamespace="http://schemas.microsoft.com/sqlserver/2004/07/adventure-works/ProductModelWarrAndMain"
    xmlns="http://schemas.microsoft.com/sqlserver/2004/07/adventure-works/ProductModelWarrAndMain" 
    elementFormDefault="qualified" 
    xmlns:xsd="http://www.w3.org/2001/XMLSchema" >
  
    <xsd:element name="Warranty"  >
        <xsd:complexType>
            <xsd:sequence>
                <xsd:element name="WarrantyPeriod" type="xsd:string"  />
                <xsd:element name="Description" type="xsd:string"  />
            </xsd:sequence>
        </xsd:complexType>
    </xsd:element>

    <xsd:element name="Maintenance"  >
        <xsd:complexType>
            <xsd:sequence>
                <xsd:element name="NoOfYears" type="xsd:string"  />
                <xsd:element name="Description" type="xsd:string"  />
            </xsd:sequence>
        </xsd:complexType>
    </xsd:element>
</xsd:schema>';
END;
GO

-- Add ProductModelDescription namespace (only if not already present)
IF NOT EXISTS (SELECT 1 FROM sys.xml_schema_namespaces WHERE name = 'http://schemas.microsoft.com/sqlserver/2004/07/adventure-works/ProductModelDescription')
BEGIN
    ALTER XML SCHEMA COLLECTION [Production].[ProductDescriptionSchemaCollection] ADD 
    '<?xml version="1.0" encoding="UTF-8"?>
    <xs:schema targetNamespace="http://schemas.microsoft.com/sqlserver/2004/07/adventure-works/ProductModelDescription" 
    xmlns="http://schemas.microsoft.com/sqlserver/2004/07/adventure-works/ProductModelDescription" 
    elementFormDefault="qualified" 
    xmlns:mstns="http://tempuri.org/XMLSchema.xsd" 
    xmlns:xs="http://www.w3.org/2001/XMLSchema"
    xmlns:wm="http://schemas.microsoft.com/sqlserver/2004/07/adventure-works/ProductModelWarrAndMain" >

    <xs:import 
        namespace="http://schemas.microsoft.com/sqlserver/2004/07/adventure-works/ProductModelWarrAndMain" />

    <xs:element name="ProductDescription" type="ProductDescription" />
        <xs:complexType name="ProductDescription">
            <xs:annotation>
                <xs:documentation>Product description has a summary blurb, if it is manufactured elsewhere it 
                includes a link to the manufacturers site for this component.
                Then it has optional zero or more sequences of features, pictures, categories
                and technical specifications.
                </xs:documentation>
            </xs:annotation>
            <xs:sequence>
                <xs:element name="Summary" type="Summary" minOccurs="0" />
                <xs:element name="Manufacturer" type="Manufacturer" minOccurs="0" />
                <xs:element name="Features" type="Features" minOccurs="0" maxOccurs="unbounded" />
                <xs:element name="Picture" type="Picture" minOccurs="0" maxOccurs="unbounded" />
                <xs:element name="Category" type="Category" minOccurs="0" maxOccurs="unbounded" />
                <xs:element name="Specifications" type="Specifications" minOccurs="0" maxOccurs="unbounded" />
            </xs:sequence>
            <xs:attribute name="ProductModelID" type="xs:string" />
            <xs:attribute name="ProductModelName" type="xs:string" />
        </xs:complexType>
  
        <xs:complexType name="Summary" mixed="true" >
            <xs:sequence>
                <xs:any processContents="skip" namespace="http://www.w3.org/1999/xhtml" minOccurs="0" maxOccurs="unbounded" />
            </xs:sequence>
        </xs:complexType>
        
        <xs:complexType name="Manufacturer">
            <xs:sequence>
                <xs:element name="Name" type="xs:string" minOccurs="0" />
                <xs:element name="CopyrightURL" type="xs:string" minOccurs="0" />
                <xs:element name="Copyright" type="xs:string" minOccurs="0" />
                <xs:element name="ProductURL" type="xs:string" minOccurs="0" />
            </xs:sequence>
        </xs:complexType>
  
        <xs:complexType name="Picture">
            <xs:annotation>
                <xs:documentation>Pictures of the component, some standard sizes are "Large" for zoom in, "Small" for a normal web page and "Thumbnail" for product listing pages.</xs:documentation>
            </xs:annotation>
            <xs:sequence>
                <xs:element name="Name" type="xs:string" minOccurs="0" />
                <xs:element name="Angle" type="xs:string" minOccurs="0" />
                <xs:element name="Size" type="xs:string" minOccurs="0" />
                <xs:element name="ProductPhotoID" type="xs:integer" minOccurs="0" />
            </xs:sequence>
        </xs:complexType>

        <xs:annotation>
            <xs:documentation>Features of the component that are more "sales" oriented.</xs:documentation>
        </xs:annotation>

        <xs:complexType name="Features" mixed="true"  >
            <xs:sequence>
                <xs:element ref="wm:Warranty"  />
                <xs:element ref="wm:Maintenance"  />
                <xs:any processContents="skip"  namespace="##other" minOccurs="0" maxOccurs="unbounded" />
            </xs:sequence>
        </xs:complexType>

        <xs:complexType name="Specifications" mixed="true">
            <xs:annotation>
                <xs:documentation>A single technical aspect of the component.</xs:documentation>
            </xs:annotation>
            <xs:sequence>
                <xs:any processContents="skip" minOccurs="0" maxOccurs="unbounded" />
            </xs:sequence>
        </xs:complexType>

        <xs:complexType name="Category">
            <xs:annotation>
                <xs:documentation>A single categorization element that designates a classification taxonomy and a code within that classification type.  Optional description for default display if needed.</xs:documentation>
            </xs:annotation>
            <xs:sequence>
                <xs:element ref="Taxonomy" />
                <xs:element ref="Code" />
                <xs:element ref="Description" minOccurs="0" />
            </xs:sequence>
        </xs:complexType>

    <xs:element name="Taxonomy" type="xs:string" />
    <xs:element name="Code" type="xs:string" />
    <xs:element name="Description" type="xs:string" />
    </xs:schema>';
END;
GO

-- Create Manufacturing instructions schema.
PRINT '';
PRINT 'Create Manufacturing instructions schema';
GO

-- Note: Cannot drop while referenced by Production.ProductModel table
IF NOT EXISTS (SELECT * FROM sys.xml_schema_collections WHERE name = 'ManuInstructionsSchemaCollection' AND schema_id = SCHEMA_ID('Production'))
BEGIN
CREATE XML SCHEMA COLLECTION [Production].[ManuInstructionsSchemaCollection] AS 
'<?xml version="1.0" encoding="UTF-8"?>
<xsd:schema targetNamespace="http://schemas.microsoft.com/sqlserver/2004/07/adventure-works/ProductModelManuInstructions" 
    xmlns="http://schemas.microsoft.com/sqlserver/2004/07/adventure-works/ProductModelManuInstructions" 
    elementFormDefault="qualified" attributeFormDefault="unqualified"
    xmlns:xsd="http://www.w3.org/2001/XMLSchema" >

    <xsd:annotation>
        <xsd:documentation>
            SetupHour   is the time it takes to set up the machine.
            MachineHour is the time the machine is busy manufcturing
            LaborHour   is the labor hours in the manu process
            LotSize     is the minimum quanity manufactured. For example,
                    no. of frames cut from the sheet metal
        </xsd:documentation>
    </xsd:annotation>

    <xsd:complexType name="StepType" mixed="true" >
        <xsd:choice  minOccurs="0" maxOccurs="unbounded" > 
            <xsd:element name="tool" type="xsd:string" />
            <xsd:element name="material" type="xsd:string" />
            <xsd:element name="blueprint" type="xsd:string" />
            <xsd:element name="specs" type="xsd:string" />
            <xsd:element name="diag" type="xsd:string" />
        </xsd:choice> 
    </xsd:complexType>

    <xsd:element  name="root">
        <xsd:complexType mixed="true">
            <xsd:sequence>
                <xsd:element name="Location" minOccurs="1" maxOccurs="unbounded">
                    <xsd:complexType mixed="true">
                        <xsd:sequence>
                            <xsd:element name="step" type="StepType" minOccurs="1" maxOccurs="unbounded" />
                        </xsd:sequence>
                        <xsd:attribute name="LocationID" type="xsd:integer" use="required"/>
                        <xsd:attribute name="SetupHours" type="xsd:decimal" use="optional"/>
                        <xsd:attribute name="MachineHours" type="xsd:decimal" use="optional"/>
                        <xsd:attribute name="LaborHours" type="xsd:decimal" use="optional"/>
                        <xsd:attribute name="LotSize" type="xsd:decimal" use="optional"/>
                    </xsd:complexType>
                </xsd:element>
            </xsd:sequence>
        </xsd:complexType>
    </xsd:element>
</xsd:schema>'
END;
GO

-- Create Store survey schema.
PRINT '';
PRINT 'Create Store survey schema';
GO

-- Note: Cannot drop while referenced by Sales.Store table
IF NOT EXISTS (SELECT * FROM sys.xml_schema_collections WHERE name = 'StoreSurveySchemaCollection' AND schema_id = SCHEMA_ID('Sales'))
BEGIN
CREATE XML SCHEMA COLLECTION [Sales].[StoreSurveySchemaCollection] AS 
'<?xml version="1.0" encoding="UTF-8"?>
<xsd:schema xmlns:xsd="http://www.w3.org/2001/XMLSchema"
    targetNamespace="http://schemas.microsoft.com/sqlserver/2004/07/adventure-works/StoreSurvey" 
    xmlns="http://schemas.microsoft.com/sqlserver/2004/07/adventure-works/StoreSurvey" 
    elementFormDefault="qualified" attributeFormDefault="unqualified">

    <!-- BM=Bicycle manu BS=bicyle store OS=online store SGS=sporting goods store D=Discount Store -->
    <xsd:simpleType name="BusinessType">
        <xsd:restriction base="xsd:string">
            <xsd:enumeration value="BM" />
            <xsd:enumeration value="BS" />
            <xsd:enumeration value="D" />
            <xsd:enumeration value="OS" />
            <xsd:enumeration value="SGS" />
        </xsd:restriction>
    </xsd:simpleType>

    <!-- BMX=BMX Racing -->
    <xsd:simpleType name="SpecialtyType">
        <xsd:restriction base="xsd:string">
            <xsd:enumeration value="Family" />
            <xsd:enumeration value="Kids" />
            <xsd:enumeration value="BMX" />
            <xsd:enumeration value="Touring" />
            <xsd:enumeration value="Road" />
            <xsd:enumeration value="Mountain" />
            <xsd:enumeration value="All" />
        </xsd:restriction>
    </xsd:simpleType>

    <!-- AW=AdventureWorks only 2= AdvWorks+1 other brand other brand -->
    <xsd:simpleType name="BrandType">
        <xsd:restriction base="xsd:string">
            <xsd:enumeration value="AW" />
            <xsd:enumeration value="2" />
            <xsd:enumeration value="3" />
            <xsd:enumeration value="4+" />
        </xsd:restriction>
    </xsd:simpleType>

    <xsd:simpleType name="InternetType">
        <xsd:restriction base="xsd:string">
            <xsd:enumeration value="56kb" />
            <xsd:enumeration value="ISDN" />
            <xsd:enumeration value="DSL" />
            <xsd:enumeration value="T1" />
            <xsd:enumeration value="T2" />
            <xsd:enumeration value="T3" />
        </xsd:restriction>
    </xsd:simpleType>

    <xsd:element name="StoreSurvey">
        <xsd:complexType>
            <xsd:sequence>
                <xsd:element name="ContactName" type="xsd:string" minOccurs="0" maxOccurs="1" />
                <xsd:element name="JobTitle" type="xsd:string" minOccurs="0" maxOccurs="1" />
                <xsd:element name="AnnualSales" type="xsd:decimal" minOccurs="0" maxOccurs="1" />
                <xsd:element name="AnnualRevenue" type="xsd:decimal" minOccurs="0" maxOccurs="1" />
                <xsd:element name="BankName" type="xsd:string" minOccurs="0" maxOccurs="1" />
                <xsd:element name="BusinessType" type="BusinessType" minOccurs="0" maxOccurs="1" />
                <xsd:element name="YearOpened" type="xsd:gYear" minOccurs="0" maxOccurs="1" />
                <xsd:element name="Specialty" type="SpecialtyType" minOccurs="0" maxOccurs="1" />
                <xsd:element name="SquareFeet" type="xsd:float" minOccurs="0" maxOccurs="1" />
                <xsd:element name="Brands" type="BrandType" minOccurs="0" maxOccurs="1" />
                <xsd:element name="Internet" type="InternetType" minOccurs="0" maxOccurs="1" />
                <xsd:element name="NumberEmployees" type="xsd:int" minOccurs="0" maxOccurs="1" />
                <xsd:element name="Comments" type="xsd:string" minOccurs="0" maxOccurs="1" />
            </xsd:sequence>
        </xsd:complexType>
    </xsd:element>
</xsd:schema>';
END;
GO


-- ******************************************************
-- Create tables
-- ******************************************************
PRINT '';
PRINT '*** Creating Tables';
GO

DROP TABLE IF EXISTS [Person].[Address];
GO

CREATE TABLE [Person].[Address](
    [AddressID] [int] IDENTITY (1, 1) NOT FOR REPLICATION NOT NULL,
    [AddressLine1] [nvarchar](60) NOT NULL, 
    [AddressLine2] [nvarchar](60) NULL, 
    [City] [nvarchar](30) NOT NULL, 
    [StateProvinceID] [int] NOT NULL,
    [PostalCode] [nvarchar](15) NOT NULL, 
	[SpatialLocation] [geography] NULL,
    [rowguid] uniqueidentifier ROWGUIDCOL NOT NULL CONSTRAINT [DF_Address_rowguid] DEFAULT (NEWID()),
    [ModifiedDate] [datetime] NOT NULL CONSTRAINT [DF_Address_ModifiedDate] DEFAULT (GETDATE())
) ON [PRIMARY];
GO

DROP TABLE IF EXISTS [Person].[AddressType];
GO

CREATE TABLE [Person].[AddressType](
    [AddressTypeID] [int] IDENTITY (1, 1) NOT NULL,
    [Name] [Name] NOT NULL,
    [rowguid] uniqueidentifier ROWGUIDCOL NOT NULL CONSTRAINT [DF_AddressType_rowguid] DEFAULT (NEWID()),
    [ModifiedDate] [datetime] NOT NULL CONSTRAINT [DF_AddressType_ModifiedDate] DEFAULT (GETDATE())
) ON [PRIMARY];
GO

DROP TABLE IF EXISTS [dbo].[AWBuildVersion];
GO

CREATE TABLE [dbo].[AWBuildVersion](
    [SystemInformationID] [tinyint] IDENTITY (1, 1) NOT NULL,
    [Database Version] [nvarchar](25) NOT NULL, 
    [VersionDate] [datetime] NOT NULL, 
    [ModifiedDate] [datetime] NOT NULL CONSTRAINT [DF_AWBuildVersion_ModifiedDate] DEFAULT (GETDATE())
) ON [PRIMARY];
GO

DROP TABLE IF EXISTS [Production].[BillOfMaterials];
GO

CREATE TABLE [Production].[BillOfMaterials](
    [BillOfMaterialsID] [int] IDENTITY (1, 1) NOT NULL,
    [ProductAssemblyID] [int] NULL,
    [ComponentID] [int] NOT NULL,
    [StartDate] [datetime] NOT NULL CONSTRAINT [DF_BillOfMaterials_StartDate] DEFAULT (GETDATE()),
    [EndDate] [datetime] NULL,
    [UnitMeasureCode] [nchar](3) NOT NULL, 
    [BOMLevel] [smallint] NOT NULL,
    [PerAssemblyQty] [decimal](8, 2) NOT NULL CONSTRAINT [DF_BillOfMaterials_PerAssemblyQty] DEFAULT (1.00),
    [ModifiedDate] [datetime] NOT NULL CONSTRAINT [DF_BillOfMaterials_ModifiedDate] DEFAULT (GETDATE()),
    CONSTRAINT [CK_BillOfMaterials_EndDate] CHECK (([EndDate] > [StartDate]) OR ([EndDate] IS NULL)),
    CONSTRAINT [CK_BillOfMaterials_ProductAssemblyID] CHECK ([ProductAssemblyID] <> [ComponentID]),
    CONSTRAINT [CK_BillOfMaterials_BOMLevel] CHECK ((([ProductAssemblyID] IS NULL) 
        AND ([BOMLevel] = 0) AND ([PerAssemblyQty] = 1.00)) 
        OR (([ProductAssemblyID] IS NOT NULL) AND ([BOMLevel] >= 1))), 
    CONSTRAINT [CK_BillOfMaterials_PerAssemblyQty] CHECK ([PerAssemblyQty] >= 1.00) 
) ON [PRIMARY];
GO

DROP TABLE IF EXISTS [Person].[BusinessEntity];
GO

CREATE TABLE [Person].[BusinessEntity](
	[BusinessEntityID] [int] IDENTITY (1, 1) NOT FOR REPLICATION NOT NULL,
    [rowguid] uniqueidentifier ROWGUIDCOL NOT NULL CONSTRAINT [DF_BusinessEntity_rowguid] DEFAULT (NEWID()), 
    [ModifiedDate] [datetime] NOT NULL CONSTRAINT [DF_BusinessEntity_ModifiedDate] DEFAULT (GETDATE())	
) ON [PRIMARY];
GO

DROP TABLE IF EXISTS [Person].[BusinessEntityAddress];
GO

CREATE TABLE [Person].[BusinessEntityAddress](
	[BusinessEntityID] [int] NOT NULL,
    [AddressID] [int] NOT NULL,
    [AddressTypeID] [int] NOT NULL,
    [rowguid] uniqueidentifier ROWGUIDCOL NOT NULL CONSTRAINT [DF_BusinessEntityAddress_rowguid] DEFAULT (NEWID()),
    [ModifiedDate] [datetime] NOT NULL CONSTRAINT [DF_BusinessEntityAddress_ModifiedDate] DEFAULT (GETDATE()) 
) ON [PRIMARY];

DROP TABLE IF EXISTS [Person].[BusinessEntityContact];
GO

CREATE TABLE [Person].[BusinessEntityContact](
	[BusinessEntityID] [int] NOT NULL,
    [PersonID] [int] NOT NULL,
    [ContactTypeID] [int] NOT NULL,
    [rowguid] uniqueidentifier ROWGUIDCOL NOT NULL CONSTRAINT [DF_BusinessEntityContact_rowguid] DEFAULT (NEWID()), 
    [ModifiedDate] [datetime] NOT NULL CONSTRAINT [DF_BusinessEntityContact_ModifiedDate] DEFAULT (GETDATE()) 
) ON [PRIMARY];
GO

DROP TABLE IF EXISTS [Person].[ContactType];
GO

CREATE TABLE [Person].[ContactType](
    [ContactTypeID] [int] IDENTITY (1, 1) NOT NULL,
    [Name] [Name] NOT NULL, 
    [ModifiedDate] [datetime] NOT NULL CONSTRAINT [DF_ContactType_ModifiedDate] DEFAULT (GETDATE()) 
) ON [PRIMARY];
GO

DROP TABLE IF EXISTS [Sales].[CountryRegionCurrency];
GO

CREATE TABLE [Sales].[CountryRegionCurrency](
    [CountryRegionCode] [nvarchar](3) NOT NULL, 
    [CurrencyCode] [nchar](3) NOT NULL, 
    [ModifiedDate] [datetime] NOT NULL CONSTRAINT [DF_CountryRegionCurrency_ModifiedDate] DEFAULT (GETDATE()) 
) ON [PRIMARY];
GO

DROP TABLE IF EXISTS [Person].[CountryRegion];
GO

CREATE TABLE [Person].[CountryRegion](
    [CountryRegionCode] [nvarchar](3) NOT NULL, 
    [Name] [Name] NOT NULL, 
    [ModifiedDate] [datetime] NOT NULL CONSTRAINT [DF_CountryRegion_ModifiedDate] DEFAULT (GETDATE()) 
) ON [PRIMARY];
GO

DROP TABLE IF EXISTS [Sales].[CreditCard];
GO

CREATE TABLE [Sales].[CreditCard](
    [CreditCardID] [int] IDENTITY (1, 1) NOT NULL,
    [CardType] [nvarchar](50) NOT NULL,
    [CardNumber] [nvarchar](25) NOT NULL,
    [ExpMonth] [tinyint] NOT NULL,
    [ExpYear] [smallint] NOT NULL, 
    [ModifiedDate] [datetime] NOT NULL CONSTRAINT [DF_CreditCard_ModifiedDate] DEFAULT (GETDATE()) 
) ON [PRIMARY];
GO

-- Drop tables that reference Culture first (enables idempotent re-runs when ProductName/Category/Subcategory exist)
DROP TABLE IF EXISTS [Production].[ProductName];
GO
DROP TABLE IF EXISTS [Production].[ProductSubcategory];
GO
DROP TABLE IF EXISTS [Production].[ProductCategory];
GO
DROP TABLE IF EXISTS [Production].[Culture];
GO

CREATE TABLE [Production].[Culture](
    [CultureID] [nchar](6) NOT NULL,
    [Name] [Name] NOT NULL, 
    [ModifiedDate] [datetime] NOT NULL CONSTRAINT [DF_Culture_ModifiedDate] DEFAULT (GETDATE()) 
) ON [PRIMARY];
GO

DROP TABLE IF EXISTS [Sales].[Currency];
GO

CREATE TABLE [Sales].[Currency](
    [CurrencyCode] [nchar](3) NOT NULL, 
    [Name] [Name] NOT NULL, 
    [ModifiedDate] [datetime] NOT NULL CONSTRAINT [DF_Currency_ModifiedDate] DEFAULT (GETDATE()) 
) ON [PRIMARY];
GO

DROP TABLE IF EXISTS [Sales].[CurrencyRate];
GO

CREATE TABLE [Sales].[CurrencyRate](
    [CurrencyRateID] [int] IDENTITY (1, 1) NOT NULL,
    [CurrencyRateDate] [datetime] NOT NULL,    
    [FromCurrencyCode] [nchar](3) NOT NULL, 
    [ToCurrencyCode] [nchar](3) NOT NULL, 
    [AverageRate] [money] NOT NULL,
    [EndOfDayRate] [money] NOT NULL, 
    [ModifiedDate] [datetime] NOT NULL CONSTRAINT [DF_CurrencyRate_ModifiedDate] DEFAULT (GETDATE()) 
) ON [PRIMARY];
GO

DROP TABLE IF EXISTS [Sales].[Customer];
GO

CREATE TABLE [Sales].[Customer](
	[CustomerID] [int] IDENTITY (1, 1) NOT FOR REPLICATION NOT NULL,
	-- A customer may either be a person, a store, or a person who works for a store
	[PersonID] [int] NULL, -- If this customer represents a person, this is non-null
    [StoreID] [int] NULL,  -- If the customer is a store, or is associated with a store then this is non-null.
    [TerritoryID] [int] NULL,
    [AccountNumber] AS ISNULL('AW' + [dbo].[ufnLeadingZeros](CustomerID), ''),
    [rowguid] uniqueidentifier ROWGUIDCOL NOT NULL CONSTRAINT [DF_Customer_rowguid] DEFAULT (NEWID()), 
    [ModifiedDate] [datetime] NOT NULL CONSTRAINT [DF_Customer_ModifiedDate] DEFAULT (GETDATE())
) ON [PRIMARY];
GO

DROP TABLE IF EXISTS [HumanResources].[Department];
GO

CREATE TABLE [HumanResources].[Department](
    [DepartmentID] [smallint] IDENTITY (1, 1) NOT NULL,
    [Name] [Name] NOT NULL,
    [GroupName] [Name] NOT NULL, 
    [ModifiedDate] [datetime] NOT NULL CONSTRAINT [DF_Department_ModifiedDate] DEFAULT (GETDATE()) 
) ON [PRIMARY];
GO

DROP TABLE IF EXISTS [Production].[Document];
GO

CREATE TABLE [Production].[Document](
    [DocumentNode] [hierarchyid] NOT NULL,
	[DocumentLevel] AS DocumentNode.GetLevel(),
    [Title] [nvarchar](50) NOT NULL, 
	[Owner] [int] NOT NULL,
	[FolderFlag] [bit] NOT NULL CONSTRAINT [DF_Document_FolderFlag] DEFAULT (0),
    [FileName] [nvarchar](400) NOT NULL, 
    [FileExtension] nvarchar(8) NOT NULL,
    [Revision] [nchar](5) NOT NULL, 
    [ChangeNumber] [int] NOT NULL CONSTRAINT [DF_Document_ChangeNumber] DEFAULT (0),
    [Status] [tinyint] NOT NULL,
    [DocumentSummary] [nvarchar](max) NULL,
    [Document] [varbinary](max)  NULL,  
    [rowguid] uniqueidentifier ROWGUIDCOL NOT NULL UNIQUE CONSTRAINT [DF_Document_rowguid] DEFAULT (NEWID()), 
    [ModifiedDate] [datetime] NOT NULL CONSTRAINT [DF_Document_ModifiedDate] DEFAULT (GETDATE()),
    CONSTRAINT [CK_Document_Status] CHECK ([Status] BETWEEN 1 AND 3)
) ON [PRIMARY];
GO

DROP TABLE IF EXISTS [Person].[EmailAddress];
GO
CREATE TABLE [Person].[EmailAddress](
	[BusinessEntityID] [int] NOT NULL,
	[EmailAddressID] [int] IDENTITY (1, 1) NOT NULL,
    [EmailAddress] [nvarchar](50) NULL, 
    [rowguid] uniqueidentifier ROWGUIDCOL NOT NULL CONSTRAINT [DF_EmailAddress_rowguid] DEFAULT (NEWID()), 
    [ModifiedDate] [datetime] NOT NULL CONSTRAINT [DF_EmailAddress_ModifiedDate] DEFAULT (GETDATE())
) ON [PRIMARY];
GO
DROP TABLE IF EXISTS [HumanResources].[Employee];
GO
CREATE TABLE [HumanResources].[Employee](
    [BusinessEntityID] [int] NOT NULL,
    [NationalIDNumber] [nvarchar](15) NOT NULL, 
    [LoginID] [nvarchar](256) NOT NULL,     
    [OrganizationNode] [hierarchyid] NULL,
	[OrganizationLevel] AS OrganizationNode.GetLevel(),
    [JobTitle] [nvarchar](50) NOT NULL, 
    [BirthDate] [date] NOT NULL,
    [MaritalStatus] [nchar](1) NOT NULL, 
    [Gender] [nchar](1) NOT NULL, 
    [HireDate] [date] NOT NULL,
    [SalariedFlag] [Flag] NOT NULL CONSTRAINT [DF_Employee_SalariedFlag] DEFAULT (1),
    [VacationHours] [smallint] NOT NULL CONSTRAINT [DF_Employee_VacationHours] DEFAULT (0),
    [SickLeaveHours] [smallint] NOT NULL CONSTRAINT [DF_Employee_SickLeaveHours] DEFAULT (0),
    [CurrentFlag] [Flag] NOT NULL CONSTRAINT [DF_Employee_CurrentFlag] DEFAULT (1),
    [rowguid] uniqueidentifier ROWGUIDCOL NOT NULL CONSTRAINT [DF_Employee_rowguid] DEFAULT (NEWID()), 
    [ModifiedDate] [datetime] NOT NULL CONSTRAINT [DF_Employee_ModifiedDate] DEFAULT (GETDATE()),
    CONSTRAINT [CK_Employee_BirthDate] CHECK ([BirthDate] BETWEEN '1930-01-01' AND DATEADD(YEAR, -18, GETDATE())),
    CONSTRAINT [CK_Employee_MaritalStatus] CHECK (UPPER([MaritalStatus]) IN ('M', 'S')), -- Married or Single
    CONSTRAINT [CK_Employee_HireDate] CHECK ([HireDate] BETWEEN '1996-07-01' AND DATEADD(DAY, 1, GETDATE())),
    CONSTRAINT [CK_Employee_Gender] CHECK (UPPER([Gender]) IN ('M', 'F')), -- Male or Female
    CONSTRAINT [CK_Employee_VacationHours] CHECK ([VacationHours] BETWEEN -40 AND 240), 
    CONSTRAINT [CK_Employee_SickLeaveHours] CHECK ([SickLeaveHours] BETWEEN 0 AND 120) 
) ON [PRIMARY];
GO

DROP TABLE IF EXISTS [HumanResources].[EmployeeDepartmentHistory];
GO

CREATE TABLE [HumanResources].[EmployeeDepartmentHistory](
    [BusinessEntityID] [int] NOT NULL,
    [DepartmentID] [smallint] NOT NULL,
    [ShiftID] [tinyint] NOT NULL,
    [StartDate] [date] NOT NULL,
    [EndDate] [date] NULL, 
    [ModifiedDate] [datetime] NOT NULL CONSTRAINT [DF_EmployeeDepartmentHistory_ModifiedDate] DEFAULT (GETDATE()), 
    CONSTRAINT [CK_EmployeeDepartmentHistory_EndDate] CHECK (([EndDate] >= [StartDate]) OR ([EndDate] IS NULL)),
) ON [PRIMARY];
GO

DROP TABLE IF EXISTS [HumanResources].[EmployeePayHistory];
GO

CREATE TABLE [HumanResources].[EmployeePayHistory](
    [BusinessEntityID] [int] NOT NULL,
    [RateChangeDate] [datetime] NOT NULL,
    [Rate] [money] NOT NULL,
    [PayFrequency] [tinyint] NOT NULL, 
    [ModifiedDate] [datetime] NOT NULL CONSTRAINT [DF_EmployeePayHistory_ModifiedDate] DEFAULT (GETDATE()),
    CONSTRAINT [CK_EmployeePayHistory_PayFrequency] CHECK ([PayFrequency] IN (1, 2)), -- 1 = monthly salary, 2 = biweekly salary
    CONSTRAINT [CK_EmployeePayHistory_Rate] CHECK ([Rate] BETWEEN 6.50 AND 200.00) 
) ON [PRIMARY];
GO

DROP TABLE IF EXISTS [Production].[Illustration];
GO

CREATE TABLE [Production].[Illustration](
    [IllustrationID] [int] IDENTITY (1, 1) NOT NULL,
    [Diagram] [XML] NULL, 
    [ModifiedDate] [datetime] NOT NULL CONSTRAINT [DF_Illustration_ModifiedDate] DEFAULT (GETDATE()) 
) ON [PRIMARY];
GO

DROP TABLE IF EXISTS [HumanResources].[JobCandidate];
GO

CREATE TABLE [HumanResources].[JobCandidate](
    [JobCandidateID] [int] IDENTITY (1, 1) NOT NULL,
    [BusinessEntityID] [int] NULL,
    [Resume] [XML]([HumanResources].[HRResumeSchemaCollection]) NULL, 
    [ModifiedDate] [datetime] NOT NULL CONSTRAINT [DF_JobCandidate_ModifiedDate] DEFAULT (GETDATE()) 
) ON [PRIMARY];
GO

DROP TABLE IF EXISTS [Production].[Location];
GO

CREATE TABLE [Production].[Location](
    [LocationID] [smallint] IDENTITY (1, 1) NOT NULL,
    [Name] [Name] NOT NULL,
    [CostRate] [smallmoney] NOT NULL CONSTRAINT [DF_Location_CostRate] DEFAULT (0.00),
    [Availability] [decimal](8, 2) NOT NULL CONSTRAINT [DF_Location_Availability] DEFAULT (0.00), 
    [ModifiedDate] [datetime] NOT NULL CONSTRAINT [DF_Location_ModifiedDate] DEFAULT (GETDATE()), 
    CONSTRAINT [CK_Location_CostRate] CHECK ([CostRate] >= 0.00), 
    CONSTRAINT [CK_Location_Availability] CHECK ([Availability] >= 0.00) 
) ON [PRIMARY];
GO

DROP TABLE IF EXISTS [Person].[Password];
GO

CREATE TABLE [Person].[Password](
	[BusinessEntityID] [int] NOT NULL,
    [PasswordHash] [varchar](128) NOT NULL, 
    [PasswordSalt] [varchar](10) NOT NULL,
    [rowguid] uniqueidentifier ROWGUIDCOL NOT NULL CONSTRAINT [DF_Password_rowguid] DEFAULT (NEWID()), 
    [ModifiedDate] [datetime] NOT NULL CONSTRAINT [DF_Password_ModifiedDate] DEFAULT (GETDATE())

) ON [PRIMARY];
GO

-- Drop foreign key constraints that reference Person.Person before dropping the table
IF EXISTS (SELECT 1 FROM sys.foreign_keys WHERE object_id = OBJECT_ID(N'[Production].[FK_ProductReview_Person_UserID]'))
BEGIN
    ALTER TABLE [Production].[ProductReview] DROP CONSTRAINT [FK_ProductReview_Person_UserID];
    PRINT 'Dropped foreign key constraint FK_ProductReview_Person_UserID';
END;
GO

DROP TABLE IF EXISTS [Person].[Person];
GO

CREATE TABLE [Person].[Person](
    [BusinessEntityID] [int] NOT NULL,
	[PersonType] [nchar](2) NOT NULL,
    [NameStyle] [NameStyle] NOT NULL CONSTRAINT [DF_Person_NameStyle] DEFAULT (0),
    [Title] [nvarchar](8) NULL, 
    [FirstName] [Name] NOT NULL,
    [MiddleName] [Name] NULL,
    [LastName] [Name] NOT NULL,
    [Suffix] [nvarchar](10) NULL, 
    [EmailPromotion] [int] NOT NULL CONSTRAINT [DF_Person_EmailPromotion] DEFAULT (0), 
    [AdditionalContactInfo] [XML]([Person].[AdditionalContactInfoSchemaCollection]) NULL,
    [Demographics] [XML]([Person].[IndividualSurveySchemaCollection]) NULL, 
    [rowguid] uniqueidentifier ROWGUIDCOL NOT NULL CONSTRAINT [DF_Person_rowguid] DEFAULT (NEWID()), 
    [ModifiedDate] [datetime] NOT NULL CONSTRAINT [DF_Person_ModifiedDate] DEFAULT (GETDATE()), 
    CONSTRAINT [CK_Person_EmailPromotion] CHECK ([EmailPromotion] BETWEEN 0 AND 2),
    CONSTRAINT [CK_Person_PersonType] CHECK ([PersonType] IS NULL OR UPPER([PersonType]) IN ('SC', 'VC', 'IN', 'EM', 'SP', 'GC'))
) ON [PRIMARY];
GO

DROP TABLE IF EXISTS [Sales].[PersonCreditCard];
GO

CREATE TABLE [Sales].[PersonCreditCard](
    [BusinessEntityID] [int] NOT NULL,
    [CreditCardID] [int] NOT NULL, 
    [ModifiedDate] [datetime] NOT NULL CONSTRAINT [DF_PersonCreditCard_ModifiedDate] DEFAULT (GETDATE()) 
) ON [PRIMARY];
GO

DROP TABLE IF EXISTS [Person].[PersonPhone];
GO

CREATE TABLE [Person].[PersonPhone](
    [BusinessEntityID] [int] NOT NULL,
	[PhoneNumber] [Phone] NOT NULL,
	[PhoneNumberTypeID] [int] NOT NULL,
    [ModifiedDate] [datetime] NOT NULL CONSTRAINT [DF_PersonPhone_ModifiedDate] DEFAULT (GETDATE()) 
) ON [PRIMARY];
GO

DROP TABLE IF EXISTS [Person].[PhoneNumberType];
GO

CREATE TABLE [Person].[PhoneNumberType](
	[PhoneNumberTypeID] [int] IDENTITY (1, 1) NOT NULL,
	[Name] [Name] NOT NULL,
    [ModifiedDate] [datetime] NOT NULL CONSTRAINT [DF_PhoneNumberType_ModifiedDate] DEFAULT (GETDATE()) 
) ON [PRIMARY];
GO

-- Note: View dependency handled by AdventureWorks-AI.sql which drops and recreates vProductAndDescription
DROP TABLE IF EXISTS [Production].[Product];
GO

CREATE TABLE [Production].[Product](
    [ProductID] [int] IDENTITY (1, 1) NOT NULL,
    [Name] [Name] NOT NULL,
    [ProductNumber] [nvarchar](25) NOT NULL, 
    [MakeFlag] [Flag] NOT NULL CONSTRAINT [DF_Product_MakeFlag] DEFAULT (1),
    [FinishedGoodsFlag] [Flag] NOT NULL CONSTRAINT [DF_Product_FinishedGoodsFlag] DEFAULT (1),
    [Color] [nvarchar](15) NULL, 
    [SafetyStockLevel] [smallint] NOT NULL,
    [ReorderPoint] [smallint] NOT NULL,
    [StandardCost] [money] NOT NULL,
    [ListPrice] [money] NOT NULL,
    [Size] [nvarchar](5) NULL, 
    [SizeUnitMeasureCode] [nchar](3) NULL, 
    [WeightUnitMeasureCode] [nchar](3) NULL, 
    [Weight] [decimal](8, 2) NULL,
    [DaysToManufacture] [int] NOT NULL,
    [ProductLine] [nchar](2) NULL, 
    [Class] [nchar](2) NULL, 
    [Style] [nchar](2) NULL, 
    [ProductSubcategoryID] [int] NULL,
    [ProductModelID] [int] NULL,
    [SellStartDate] [datetime] NOT NULL,
    [SellEndDate] [datetime] NULL,
    [DiscontinuedDate] [datetime] NULL,
    [rowguid] uniqueidentifier ROWGUIDCOL NOT NULL CONSTRAINT [DF_Product_rowguid] DEFAULT (NEWID()), 
    [ModifiedDate] [datetime] NOT NULL CONSTRAINT [DF_Product_ModifiedDate] DEFAULT (GETDATE()),
    CONSTRAINT [CK_Product_SafetyStockLevel] CHECK ([SafetyStockLevel] > 0),
    CONSTRAINT [CK_Product_ReorderPoint] CHECK ([ReorderPoint] > 0),
    CONSTRAINT [CK_Product_StandardCost] CHECK ([StandardCost] >= 0.00),
    CONSTRAINT [CK_Product_ListPrice] CHECK ([ListPrice] >= 0.00),
    CONSTRAINT [CK_Product_Weight] CHECK ([Weight] > 0.00),
    CONSTRAINT [CK_Product_DaysToManufacture] CHECK ([DaysToManufacture] >= 0),
    CONSTRAINT [CK_Product_ProductLine] CHECK (UPPER([ProductLine]) IN ('S', 'T', 'M', 'R') OR [ProductLine] IS NULL),
    CONSTRAINT [CK_Product_Class] CHECK (UPPER([Class]) IN ('L', 'M', 'H') OR [Class] IS NULL),
    CONSTRAINT [CK_Product_Style] CHECK (UPPER([Style]) IN ('W', 'M', 'U') OR [Style] IS NULL), 
    CONSTRAINT [CK_Product_SellEndDate] CHECK (([SellEndDate] >= [SellStartDate]) OR ([SellEndDate] IS NULL)),
) ON [PRIMARY];
GO

DROP TABLE IF EXISTS [Production].[ProductCategory];
GO

CREATE TABLE [Production].[ProductCategory](
    [ProductCategoryID] [int] NOT NULL,
    [CultureID] [nchar](6) NOT NULL,
    [Name] [Name] NOT NULL,
    [rowguid] uniqueidentifier ROWGUIDCOL NOT NULL CONSTRAINT [DF_ProductCategory_rowguid] DEFAULT (NEWID()), 
    [ModifiedDate] [datetime] NOT NULL CONSTRAINT [DF_ProductCategory_ModifiedDate] DEFAULT (GETDATE()) 
) ON [PRIMARY];
GO

DROP TABLE IF EXISTS [Production].[ProductCostHistory];
GO

CREATE TABLE [Production].[ProductCostHistory](
    [ProductID] [int] NOT NULL,
    [StartDate] [datetime] NOT NULL,
    [EndDate] [datetime] NULL,
    [StandardCost] [money] NOT NULL, 
    [ModifiedDate] [datetime] NOT NULL CONSTRAINT [DF_ProductCostHistory_ModifiedDate] DEFAULT (GETDATE()),
    CONSTRAINT [CK_ProductCostHistory_EndDate] CHECK (([EndDate] >= [StartDate]) OR ([EndDate] IS NULL)),
    CONSTRAINT [CK_ProductCostHistory_StandardCost] CHECK ([StandardCost] >= 0.00)
) ON [PRIMARY];
GO

-- Note: View dependency handled by AdventureWorks-AI.sql which drops and recreates vProductAndDescription
-- Drop child table first (references ProductDescription) so parent can be dropped
DROP TABLE IF EXISTS [Production].[ProductModelProductDescriptionCulture];
GO

DROP TABLE IF EXISTS [Production].[ProductDescription];
GO

CREATE TABLE [Production].[ProductDescription](
    [ProductDescriptionID] [int] IDENTITY (1, 1) NOT NULL,
    [Description] [nvarchar](400) NOT NULL,
    [rowguid] uniqueidentifier ROWGUIDCOL NOT NULL CONSTRAINT [DF_ProductDescription_rowguid] DEFAULT (NEWID()), 
    [ModifiedDate] [datetime] NOT NULL CONSTRAINT [DF_ProductDescription_ModifiedDate] DEFAULT (GETDATE()) 
) ON [PRIMARY];
GO

DROP TABLE IF EXISTS [Production].[ProductDocument];
GO

CREATE TABLE [Production].[ProductDocument](
    [ProductID] [int] NOT NULL,
    [DocumentNode] [hierarchyid] NOT NULL, 
    [ModifiedDate] [datetime] NOT NULL CONSTRAINT [DF_ProductDocument_ModifiedDate] DEFAULT (GETDATE()) 
) ON [PRIMARY];
GO

DROP TABLE IF EXISTS [Production].[ProductInventory];
GO

CREATE TABLE [Production].[ProductInventory](
    [ProductID] [int] NOT NULL,
    [LocationID] [smallint] NOT NULL,
    [Shelf] [nvarchar](10) NOT NULL, 
    [Bin] [tinyint] NOT NULL,
    [Quantity] [smallint] NOT NULL CONSTRAINT [DF_ProductInventory_Quantity] DEFAULT (0),
    [rowguid] uniqueidentifier ROWGUIDCOL NOT NULL CONSTRAINT [DF_ProductInventory_rowguid] DEFAULT (NEWID()), 
    [ModifiedDate] [datetime] NOT NULL CONSTRAINT [DF_ProductInventory_ModifiedDate] DEFAULT (GETDATE()),
    CONSTRAINT [CK_ProductInventory_Shelf] CHECK (([Shelf] LIKE '[A-Za-z]') OR ([Shelf] = 'N/A')),
    CONSTRAINT [CK_ProductInventory_Bin] CHECK ([Bin] BETWEEN 0 AND 100)
) ON [PRIMARY];
GO

DROP TABLE IF EXISTS [Production].[ProductListPriceHistory];
GO

CREATE TABLE [Production].[ProductListPriceHistory](
    [ProductID] [int] NOT NULL,
    [StartDate] [datetime] NOT NULL,
    [EndDate] [datetime] NULL,
    [ListPrice] [money] NOT NULL, 
    [ModifiedDate] [datetime] NOT NULL CONSTRAINT [DF_ProductListPriceHistory_ModifiedDate] DEFAULT (GETDATE()), 
    CONSTRAINT [CK_ProductListPriceHistory_EndDate] CHECK (([EndDate] >= [StartDate]) OR ([EndDate] IS NULL)),
    CONSTRAINT [CK_ProductListPriceHistory_ListPrice] CHECK ([ListPrice] > 0.00)
) ON [PRIMARY];
GO

-- Note: View dependency handled by AdventureWorks-AI.sql which drops and recreates vProductAndDescription
DROP TABLE IF EXISTS [Production].[ProductModel];
GO

CREATE TABLE [Production].[ProductModel](
    [ProductModelID] [int] IDENTITY (1, 1) NOT NULL,
    [Name] [Name] NOT NULL,
    [CatalogDescription] [XML]([Production].[ProductDescriptionSchemaCollection]) NULL,
    [Instructions] [XML]([Production].[ManuInstructionsSchemaCollection]) NULL,
    [rowguid] uniqueidentifier ROWGUIDCOL NOT NULL CONSTRAINT [DF_ProductModel_rowguid] DEFAULT (NEWID()), 
    [ModifiedDate] [datetime] NOT NULL CONSTRAINT [DF_ProductModel_ModifiedDate] DEFAULT (GETDATE()) 
) ON [PRIMARY];
GO

DROP TABLE IF EXISTS [Production].[ProductModelIllustration];
GO

CREATE TABLE [Production].[ProductModelIllustration](
    [ProductModelID] [int] NOT NULL,
    [IllustrationID] [int] NOT NULL, 
    [ModifiedDate] [datetime] NOT NULL CONSTRAINT [DF_ProductModelIllustration_ModifiedDate] DEFAULT (GETDATE()) 
) ON [PRIMARY];
GO

-- Note: View dependency handled by AdventureWorks-AI.sql which drops and recreates vProductAndDescription
DROP TABLE IF EXISTS [Production].[ProductModelProductDescriptionCulture];
GO

CREATE TABLE [Production].[ProductModelProductDescriptionCulture](
    [ProductModelID] [int] NOT NULL,
    [ProductDescriptionID] [int] NOT NULL,
    [CultureID] [nchar](6) NOT NULL, 
    [ModifiedDate] [datetime] NOT NULL CONSTRAINT [DF_ProductModelProductDescriptionCulture_ModifiedDate] DEFAULT (GETDATE()) 
) ON [PRIMARY];
GO

DROP TABLE IF EXISTS [Production].[ProductPhoto];
GO

CREATE TABLE [Production].[ProductPhoto](
    [ProductPhotoID] [int] IDENTITY (1, 1) NOT NULL,
    [ThumbNailPhoto] [varbinary](max) NULL,
    [ThumbnailPhotoFileName] [nvarchar](50) NULL,
    [LargePhoto] [varbinary](max) NULL,
    [LargePhotoFileName] [nvarchar](50) NULL, 
    [ModifiedDate] [datetime] NOT NULL CONSTRAINT [DF_ProductPhoto_ModifiedDate] DEFAULT (GETDATE()) 
) ON [PRIMARY];
GO

DROP TABLE IF EXISTS [Production].[ProductProductPhoto];
GO

CREATE TABLE [Production].[ProductProductPhoto](
    [ProductID] [int] NOT NULL,
    [ProductPhotoID] [int] NOT NULL,
    [Primary] [Flag] NOT NULL CONSTRAINT [DF_ProductProductPhoto_Primary] DEFAULT (0),
    [ModifiedDate] [datetime] NOT NULL CONSTRAINT [DF_ProductProductPhoto_ModifiedDate] DEFAULT (GETDATE()) 
) ON [PRIMARY];
GO

DROP TABLE IF EXISTS [Production].[ProductReview];
GO

CREATE TABLE [Production].[ProductReview](
    [ProductReviewID] [int] IDENTITY (1, 1) NOT NULL,
    [ProductID] [int] NOT NULL,
    [ReviewerName] [Name] NOT NULL,
    [ReviewDate] [datetime] NOT NULL CONSTRAINT [DF_ProductReview_ReviewDate] DEFAULT (GETDATE()),
    [EmailAddress] [nvarchar](50) NOT NULL,
    [Rating] [int] NOT NULL,
    [Comments] [nvarchar](3850), 
    [ModifiedDate] [datetime] NOT NULL CONSTRAINT [DF_ProductReview_ModifiedDate] DEFAULT (GETDATE()), 
    CONSTRAINT [CK_ProductReview_Rating] CHECK ([Rating] BETWEEN 1 AND 5), 
) ON [PRIMARY];
GO

DROP TABLE IF EXISTS [Production].[ProductSubcategory];
GO

CREATE TABLE [Production].[ProductSubcategory](
    [ProductSubcategoryID] [int] NOT NULL,
    [ProductCategoryID] [int] NOT NULL,
    [CultureID] [nchar](6) NOT NULL,
    [Name] [Name] NOT NULL,
    [rowguid] uniqueidentifier ROWGUIDCOL NOT NULL CONSTRAINT [DF_ProductSubcategory_rowguid] DEFAULT (NEWID()), 
    [ModifiedDate] [datetime] NOT NULL CONSTRAINT [DF_ProductSubcategory_ModifiedDate] DEFAULT (GETDATE()) 
) ON [PRIMARY];
GO

DROP TABLE IF EXISTS [Purchasing].[ProductVendor];
GO

CREATE TABLE [Purchasing].[ProductVendor](
    [ProductID] [int] NOT NULL,
    [BusinessEntityID] [int] NOT NULL,
    [AverageLeadTime] [int] NOT NULL,
    [StandardPrice] [money] NOT NULL,
    [LastReceiptCost] [money] NULL,
    [LastReceiptDate] [datetime] NULL,
    [MinOrderQty] [int] NOT NULL,
    [MaxOrderQty] [int] NOT NULL,
    [OnOrderQty] [int] NULL,
    [UnitMeasureCode] [nchar](3) NOT NULL, 
    [ModifiedDate] [datetime] NOT NULL CONSTRAINT [DF_ProductVendor_ModifiedDate] DEFAULT (GETDATE()), 
    CONSTRAINT [CK_ProductVendor_AverageLeadTime] CHECK ([AverageLeadTime] >= 1),
    CONSTRAINT [CK_ProductVendor_StandardPrice] CHECK ([StandardPrice] > 0.00),
    CONSTRAINT [CK_ProductVendor_LastReceiptCost] CHECK ([LastReceiptCost] > 0.00),
    CONSTRAINT [CK_ProductVendor_MinOrderQty] CHECK ([MinOrderQty] >= 1),
    CONSTRAINT [CK_ProductVendor_MaxOrderQty] CHECK ([MaxOrderQty] >= 1),
    CONSTRAINT [CK_ProductVendor_OnOrderQty] CHECK ([OnOrderQty] >= 0)
) ON [PRIMARY];
GO

DROP TABLE IF EXISTS [Purchasing].[PurchaseOrderDetail];
GO

CREATE TABLE [Purchasing].[PurchaseOrderDetail](
    [PurchaseOrderID] [int] NOT NULL,
    [PurchaseOrderDetailID] [int] IDENTITY (1, 1) NOT NULL,
    [DueDate] [datetime] NOT NULL,
    [OrderQty] [smallint] NOT NULL,
    [ProductID] [int] NOT NULL,
    [UnitPrice] [money] NOT NULL,
    [LineTotal] AS ISNULL([OrderQty] * [UnitPrice], 0.00), 
    [ReceivedQty] [decimal](8, 2) NOT NULL,
    [RejectedQty] [decimal](8, 2) NOT NULL,
    [StockedQty] AS ISNULL([ReceivedQty] - [RejectedQty], 0.00),
    [ModifiedDate] [datetime] NOT NULL CONSTRAINT [DF_PurchaseOrderDetail_ModifiedDate] DEFAULT (GETDATE()), 
    CONSTRAINT [CK_PurchaseOrderDetail_OrderQty] CHECK ([OrderQty] > 0), 
    CONSTRAINT [CK_PurchaseOrderDetail_UnitPrice] CHECK ([UnitPrice] >= 0.00), 
    CONSTRAINT [CK_PurchaseOrderDetail_ReceivedQty] CHECK ([ReceivedQty] >= 0.00), 
    CONSTRAINT [CK_PurchaseOrderDetail_RejectedQty] CHECK ([RejectedQty] >= 0.00) 
) ON [PRIMARY];
GO

DROP TABLE IF EXISTS [Purchasing].[PurchaseOrderHeader];
GO

CREATE TABLE [Purchasing].[PurchaseOrderHeader](
    [PurchaseOrderID] [int] IDENTITY (1, 1) NOT NULL, 
    [RevisionNumber] [tinyint] NOT NULL CONSTRAINT [DF_PurchaseOrderHeader_RevisionNumber] DEFAULT (0), 
    [Status] [tinyint] NOT NULL CONSTRAINT [DF_PurchaseOrderHeader_Status] DEFAULT (1), 
    [EmployeeID] [int] NOT NULL, 
    [VendorID] [int] NOT NULL, 
    [ShipMethodID] [int] NOT NULL, 
    [OrderDate] [datetime] NOT NULL CONSTRAINT [DF_PurchaseOrderHeader_OrderDate] DEFAULT (GETDATE()), 
    [ShipDate] [datetime] NULL, 
    [SubTotal] [money] NOT NULL CONSTRAINT [DF_PurchaseOrderHeader_SubTotal] DEFAULT (0.00), 
    [TaxAmt] [money] NOT NULL CONSTRAINT [DF_PurchaseOrderHeader_TaxAmt] DEFAULT (0.00), 
    [Freight] [money] NOT NULL CONSTRAINT [DF_PurchaseOrderHeader_Freight] DEFAULT (0.00), 
    [TotalDue] AS ISNULL([SubTotal] + [TaxAmt] + [Freight], 0) PERSISTED NOT NULL, 
    [ModifiedDate] [datetime] NOT NULL CONSTRAINT [DF_PurchaseOrderHeader_ModifiedDate] DEFAULT (GETDATE()), 
    CONSTRAINT [CK_PurchaseOrderHeader_Status] CHECK ([Status] BETWEEN 1 AND 4), -- 1 = Pending; 2 = Approved; 3 = Rejected; 4 = Complete 
    CONSTRAINT [CK_PurchaseOrderHeader_ShipDate] CHECK (([ShipDate] >= [OrderDate]) OR ([ShipDate] IS NULL)), 
    CONSTRAINT [CK_PurchaseOrderHeader_SubTotal] CHECK ([SubTotal] >= 0.00), 
    CONSTRAINT [CK_PurchaseOrderHeader_TaxAmt] CHECK ([TaxAmt] >= 0.00), 
    CONSTRAINT [CK_PurchaseOrderHeader_Freight] CHECK ([Freight] >= 0.00) 
) ON [PRIMARY];
GO

DROP TABLE IF EXISTS [Sales].[SalesOrderDetail];
GO

CREATE TABLE [Sales].[SalesOrderDetail](
    [SalesOrderID] [int] NOT NULL,
    [SalesOrderDetailID] [int] IDENTITY (1, 1) NOT NULL,
    [CarrierTrackingNumber] [nvarchar](25) NULL, 
    [OrderQty] [smallint] NOT NULL,
    [ProductID] [int] NOT NULL,
    [SpecialOfferID] [int] NOT NULL,
    [UnitPrice] [money] NOT NULL,
    [UnitPriceDiscount] [money] NOT NULL CONSTRAINT [DF_SalesOrderDetail_UnitPriceDiscount] DEFAULT (0.0),
    [LineTotal] AS ISNULL([UnitPrice] * (1.0 - [UnitPriceDiscount]) * [OrderQty], 0.0),
    [rowguid] uniqueidentifier ROWGUIDCOL NOT NULL CONSTRAINT [DF_SalesOrderDetail_rowguid] DEFAULT (NEWID()), 
    [ModifiedDate] [datetime] NOT NULL CONSTRAINT [DF_SalesOrderDetail_ModifiedDate] DEFAULT (GETDATE()), 
    CONSTRAINT [CK_SalesOrderDetail_OrderQty] CHECK ([OrderQty] > 0), 
    CONSTRAINT [CK_SalesOrderDetail_UnitPrice] CHECK ([UnitPrice] >= 0.00), 
    CONSTRAINT [CK_SalesOrderDetail_UnitPriceDiscount] CHECK ([UnitPriceDiscount] >= 0.00) 
) ON [PRIMARY];
GO

DROP TABLE IF EXISTS [Sales].[SalesOrderHeader];
GO

CREATE TABLE [Sales].[SalesOrderHeader](
    [SalesOrderID] [int] IDENTITY (1, 1) NOT FOR REPLICATION NOT NULL,
    [RevisionNumber] [tinyint] NOT NULL CONSTRAINT [DF_SalesOrderHeader_RevisionNumber] DEFAULT (0),
    [OrderDate] [datetime] NOT NULL CONSTRAINT [DF_SalesOrderHeader_OrderDate] DEFAULT (GETDATE()),
    [DueDate] [datetime] NOT NULL,
    [ShipDate] [datetime] NULL,
    [Status] [tinyint] NOT NULL CONSTRAINT [DF_SalesOrderHeader_Status] DEFAULT (1),
    [OnlineOrderFlag] [Flag] NOT NULL CONSTRAINT [DF_SalesOrderHeader_OnlineOrderFlag] DEFAULT (1),
    [SalesOrderNumber] AS ISNULL(N'SO' + CONVERT(nvarchar(23), [SalesOrderID]), N'*** ERROR ***'), 
    [PurchaseOrderNumber] [OrderNumber] NULL,
    [AccountNumber] [AccountNumber] NULL,
    [CustomerID] [int] NOT NULL,
    [SalesPersonID] [int] NULL,
    [TerritoryID] [int] NULL,
    [BillToAddressID] [int] NOT NULL,
    [ShipToAddressID] [int] NOT NULL,
    [ShipMethodID] [int] NOT NULL,
    [CreditCardID] [int] NULL,
    [CreditCardApprovalCode] [varchar](15) NULL,    
    [CurrencyRateID] [int] NULL,
    [SubTotal] [money] NOT NULL CONSTRAINT [DF_SalesOrderHeader_SubTotal] DEFAULT (0.00),
    [TaxAmt] [money] NOT NULL CONSTRAINT [DF_SalesOrderHeader_TaxAmt] DEFAULT (0.00),
    [Freight] [money] NOT NULL CONSTRAINT [DF_SalesOrderHeader_Freight] DEFAULT (0.00),
    [TotalDue] AS ISNULL([SubTotal] + [TaxAmt] + [Freight], 0),
    [Comment] [nvarchar](128) NULL,
    [rowguid] uniqueidentifier ROWGUIDCOL NOT NULL CONSTRAINT [DF_SalesOrderHeader_rowguid] DEFAULT (NEWID()), 
    [ModifiedDate] [datetime] NOT NULL CONSTRAINT [DF_SalesOrderHeader_ModifiedDate] DEFAULT (GETDATE()),
    CONSTRAINT [CK_SalesOrderHeader_Status] CHECK ([Status] BETWEEN 0 AND 8), 
    CONSTRAINT [CK_SalesOrderHeader_DueDate] CHECK ([DueDate] >= [OrderDate]), 
    CONSTRAINT [CK_SalesOrderHeader_ShipDate] CHECK (([ShipDate] >= [OrderDate]) OR ([ShipDate] IS NULL)), 
    CONSTRAINT [CK_SalesOrderHeader_SubTotal] CHECK ([SubTotal] >= 0.00), 
    CONSTRAINT [CK_SalesOrderHeader_TaxAmt] CHECK ([TaxAmt] >= 0.00), 
    CONSTRAINT [CK_SalesOrderHeader_Freight] CHECK ([Freight] >= 0.00) 
) ON [PRIMARY];
GO

DROP TABLE IF EXISTS [Sales].[SalesOrderHeaderSalesReason];
GO

CREATE TABLE [Sales].[SalesOrderHeaderSalesReason](
    [SalesOrderID] [int] NOT NULL,
    [SalesReasonID] [int] NOT NULL, 
    [ModifiedDate] [datetime] NOT NULL CONSTRAINT [DF_SalesOrderHeaderSalesReason_ModifiedDate] DEFAULT (GETDATE()) 
) ON [PRIMARY];
GO

DROP TABLE IF EXISTS [Sales].[SalesPerson];
GO

CREATE TABLE [Sales].[SalesPerson](
    [BusinessEntityID] [int] NOT NULL,
    [TerritoryID] [int] NULL,
    [SalesQuota] [money] NULL,
    [Bonus] [money] NOT NULL CONSTRAINT [DF_SalesPerson_Bonus] DEFAULT (0.00),
    [CommissionPct] [smallmoney] NOT NULL CONSTRAINT [DF_SalesPerson_CommissionPct] DEFAULT (0.00),
    [SalesYTD] [money] NOT NULL CONSTRAINT [DF_SalesPerson_SalesYTD] DEFAULT (0.00),
    [SalesLastYear] [money] NOT NULL CONSTRAINT [DF_SalesPerson_SalesLastYear] DEFAULT (0.00),
    [rowguid] uniqueidentifier ROWGUIDCOL NOT NULL CONSTRAINT [DF_SalesPerson_rowguid] DEFAULT (NEWID()), 
    [ModifiedDate] [datetime] NOT NULL CONSTRAINT [DF_SalesPerson_ModifiedDate] DEFAULT (GETDATE()), 
    CONSTRAINT [CK_SalesPerson_SalesQuota] CHECK ([SalesQuota] > 0.00), 
    CONSTRAINT [CK_SalesPerson_Bonus] CHECK ([Bonus] >= 0.00), 
    CONSTRAINT [CK_SalesPerson_CommissionPct] CHECK ([CommissionPct] >= 0.00), 
    CONSTRAINT [CK_SalesPerson_SalesYTD] CHECK ([SalesYTD] >= 0.00), 
    CONSTRAINT [CK_SalesPerson_SalesLastYear] CHECK ([SalesLastYear] >= 0.00) 
) ON [PRIMARY];
GO

DROP TABLE IF EXISTS [Sales].[SalesPersonQuotaHistory];
GO

CREATE TABLE [Sales].[SalesPersonQuotaHistory](
    [BusinessEntityID] [int] NOT NULL,
    [QuotaDate] [datetime] NOT NULL,
    [SalesQuota] [money] NOT NULL,
    [rowguid] uniqueidentifier ROWGUIDCOL NOT NULL CONSTRAINT [DF_SalesPersonQuotaHistory_rowguid] DEFAULT (NEWID()), 
    [ModifiedDate] [datetime] NOT NULL CONSTRAINT [DF_SalesPersonQuotaHistory_ModifiedDate] DEFAULT (GETDATE()), 
    CONSTRAINT [CK_SalesPersonQuotaHistory_SalesQuota] CHECK ([SalesQuota] > 0.00) 
) ON [PRIMARY];
GO

DROP TABLE IF EXISTS [Sales].[SalesReason];
GO

CREATE TABLE [Sales].[SalesReason](
    [SalesReasonID] [int] IDENTITY (1, 1) NOT NULL,
    [Name] [Name] NOT NULL,
    [ReasonType] [Name] NOT NULL, 
    [ModifiedDate] [datetime] NOT NULL CONSTRAINT [DF_SalesReason_ModifiedDate] DEFAULT (GETDATE()) 
) ON [PRIMARY];
GO

DROP TABLE IF EXISTS [Sales].[SalesTaxRate];
GO

CREATE TABLE [Sales].[SalesTaxRate](
    [SalesTaxRateID] [int] IDENTITY (1, 1) NOT NULL,
    [StateProvinceID] [int] NOT NULL,
    [TaxType] [tinyint] NOT NULL,
    [TaxRate] [smallmoney] NOT NULL CONSTRAINT [DF_SalesTaxRate_TaxRate] DEFAULT (0.00),
    [Name] [Name] NOT NULL,
    [rowguid] uniqueidentifier ROWGUIDCOL NOT NULL CONSTRAINT [DF_SalesTaxRate_rowguid] DEFAULT (NEWID()), 
    [ModifiedDate] [datetime] NOT NULL CONSTRAINT [DF_SalesTaxRate_ModifiedDate] DEFAULT (GETDATE()),
    CONSTRAINT [CK_SalesTaxRate_TaxType] CHECK ([TaxType] BETWEEN 1 AND 3)
) ON [PRIMARY];
GO

DROP TABLE IF EXISTS [Sales].[SalesTerritory];
GO

CREATE TABLE [Sales].[SalesTerritory](
    [TerritoryID] [int] IDENTITY (1, 1) NOT NULL,
    [Name] [Name] NOT NULL,
    [CountryRegionCode] [nvarchar](3) NOT NULL, 
    [Group] [nvarchar](50) NOT NULL,
    [SalesYTD] [money] NOT NULL CONSTRAINT [DF_SalesTerritory_SalesYTD] DEFAULT (0.00),
    [SalesLastYear] [money] NOT NULL CONSTRAINT [DF_SalesTerritory_SalesLastYear] DEFAULT (0.00),
    [CostYTD] [money] NOT NULL CONSTRAINT [DF_SalesTerritory_CostYTD] DEFAULT (0.00),
    [CostLastYear] [money] NOT NULL CONSTRAINT [DF_SalesTerritory_CostLastYear] DEFAULT (0.00),
    [rowguid] uniqueidentifier ROWGUIDCOL NOT NULL CONSTRAINT [DF_SalesTerritory_rowguid] DEFAULT (NEWID()), 
    [ModifiedDate] [datetime] NOT NULL CONSTRAINT [DF_SalesTerritory_ModifiedDate] DEFAULT (GETDATE()), 
    CONSTRAINT [CK_SalesTerritory_SalesYTD] CHECK ([SalesYTD] >= 0.00), 
    CONSTRAINT [CK_SalesTerritory_SalesLastYear] CHECK ([SalesLastYear] >= 0.00), 
    CONSTRAINT [CK_SalesTerritory_CostYTD] CHECK ([CostYTD] >= 0.00), 
    CONSTRAINT [CK_SalesTerritory_CostLastYear] CHECK ([CostLastYear] >= 0.00) 
) ON [PRIMARY];
GO

DROP TABLE IF EXISTS [Sales].[SalesTerritoryHistory];
GO

CREATE TABLE [Sales].[SalesTerritoryHistory](
    [BusinessEntityID] [int] NOT NULL,  -- A sales person
    [TerritoryID] [int] NOT NULL,
    [StartDate] [datetime] NOT NULL,
    [EndDate] [datetime] NULL,
    [rowguid] uniqueidentifier ROWGUIDCOL NOT NULL CONSTRAINT [DF_SalesTerritoryHistory_rowguid] DEFAULT (NEWID()), 
    [ModifiedDate] [datetime] NOT NULL CONSTRAINT [DF_SalesTerritoryHistory_ModifiedDate] DEFAULT (GETDATE()), 
    CONSTRAINT [CK_SalesTerritoryHistory_EndDate] CHECK (([EndDate] >= [StartDate]) OR ([EndDate] IS NULL))
) ON [PRIMARY];
GO

DROP TABLE IF EXISTS [Production].[ScrapReason];
GO

CREATE TABLE [Production].[ScrapReason](
    [ScrapReasonID] [smallint] IDENTITY (1, 1) NOT NULL,
    [Name] [Name] NOT NULL, 
    [ModifiedDate] [datetime] NOT NULL CONSTRAINT [DF_ScrapReason_ModifiedDate] DEFAULT (GETDATE()) 
) ON [PRIMARY];
GO

DROP TABLE IF EXISTS [HumanResources].[Shift];
GO

CREATE TABLE [HumanResources].[Shift](
    [ShiftID] [tinyint] IDENTITY (1, 1) NOT NULL,
    [Name] [Name] NOT NULL,
    [StartTime] [time] NOT NULL,
    [EndTime] [time] NOT NULL, 
    [ModifiedDate] [datetime] NOT NULL CONSTRAINT [DF_Shift_ModifiedDate] DEFAULT (GETDATE()) 
) ON [PRIMARY];
GO

DROP TABLE IF EXISTS [Purchasing].[ShipMethod];
GO

CREATE TABLE [Purchasing].[ShipMethod](
    [ShipMethodID] [int] IDENTITY (1, 1) NOT NULL,
    [Name] [Name] NOT NULL,
    [ShipBase] [money] NOT NULL CONSTRAINT [DF_ShipMethod_ShipBase] DEFAULT (0.00),
    [ShipRate] [money] NOT NULL CONSTRAINT [DF_ShipMethod_ShipRate] DEFAULT (0.00),
    [rowguid] uniqueidentifier ROWGUIDCOL NOT NULL CONSTRAINT [DF_ShipMethod_rowguid] DEFAULT (NEWID()), 
    [ModifiedDate] [datetime] NOT NULL CONSTRAINT [DF_ShipMethod_ModifiedDate] DEFAULT (GETDATE()), 
    CONSTRAINT [CK_ShipMethod_ShipBase] CHECK ([ShipBase] > 0.00), 
    CONSTRAINT [CK_ShipMethod_ShipRate] CHECK ([ShipRate] > 0.00), 
) ON [PRIMARY];
GO

DROP TABLE IF EXISTS [Sales].[ShoppingCartItem];
GO

CREATE TABLE [Sales].[ShoppingCartItem](
    [ShoppingCartItemID] [int] IDENTITY (1, 1) NOT NULL,
    [ShoppingCartID] [nvarchar](50) NOT NULL,
    [Quantity] [int] NOT NULL CONSTRAINT [DF_ShoppingCartItem_Quantity] DEFAULT (1),
    [ProductID] [int] NOT NULL,
    [DateCreated] [datetime] NOT NULL CONSTRAINT [DF_ShoppingCartItem_DateCreated] DEFAULT (GETDATE()), 
    [ModifiedDate] [datetime] NOT NULL CONSTRAINT [DF_ShoppingCartItem_ModifiedDate] DEFAULT (GETDATE()), 
    CONSTRAINT [CK_ShoppingCartItem_Quantity] CHECK ([Quantity] >= 1) 
) ON [PRIMARY];
GO

DROP TABLE IF EXISTS [Sales].[SpecialOffer];
GO

CREATE TABLE [Sales].[SpecialOffer](
    [SpecialOfferID] [int] NOT NULL,
    [CultureID] [nchar](6) NOT NULL,
    [Description] [nvarchar](255) NOT NULL,
    [DiscountPct] [smallmoney] NOT NULL CONSTRAINT [DF_SpecialOffer_DiscountPct] DEFAULT (0.00),
    [Type] [nvarchar](50) NOT NULL,
    [Category] [nvarchar](50) NOT NULL,
    [StartDate] [datetime] NOT NULL,
    [EndDate] [datetime] NOT NULL,
    [MinQty] [int] NOT NULL CONSTRAINT [DF_SpecialOffer_MinQty] DEFAULT (0), 
    [MaxQty] [int] NULL,
    [rowguid] uniqueidentifier ROWGUIDCOL NOT NULL CONSTRAINT [DF_SpecialOffer_rowguid] DEFAULT (NEWID()), 
    [ModifiedDate] [datetime] NOT NULL CONSTRAINT [DF_SpecialOffer_ModifiedDate] DEFAULT (GETDATE()), 
    CONSTRAINT [CK_SpecialOffer_EndDate] CHECK ([EndDate] >= [StartDate]), 
    CONSTRAINT [CK_SpecialOffer_DiscountPct] CHECK ([DiscountPct] >= 0.00), 
    CONSTRAINT [CK_SpecialOffer_MinQty] CHECK ([MinQty] >= 0), 
    CONSTRAINT [CK_SpecialOffer_MaxQty]  CHECK ([MaxQty] >= 0)
) ON [PRIMARY];
GO

DROP TABLE IF EXISTS [Sales].[SpecialOfferProduct];
GO

CREATE TABLE [Sales].[SpecialOfferProduct](
    [SpecialOfferID] [int] NOT NULL,
    [ProductID] [int] NOT NULL,
    [rowguid] uniqueidentifier ROWGUIDCOL NOT NULL CONSTRAINT [DF_SpecialOfferProduct_rowguid] DEFAULT (NEWID()), 
    [ModifiedDate] [datetime] NOT NULL CONSTRAINT [DF_SpecialOfferProduct_ModifiedDate] DEFAULT (GETDATE()) 
) ON [PRIMARY];
GO

DROP TABLE IF EXISTS [Person].[StateProvince];
GO

CREATE TABLE [Person].[StateProvince](
    [StateProvinceID] [int] IDENTITY (1, 1) NOT NULL,
    [StateProvinceCode] [nchar](3) NOT NULL, 
    [CountryRegionCode] [nvarchar](3) NOT NULL, 
    [IsOnlyStateProvinceFlag] [Flag] NOT NULL CONSTRAINT [DF_StateProvince_IsOnlyStateProvinceFlag] DEFAULT (1),
    [Name] [Name] NOT NULL,
    [TerritoryID] [int] NOT NULL,
    [rowguid] uniqueidentifier ROWGUIDCOL NOT NULL CONSTRAINT [DF_StateProvince_rowguid] DEFAULT (NEWID()), 
    [ModifiedDate] [datetime] NOT NULL CONSTRAINT [DF_StateProvince_ModifiedDate] DEFAULT (GETDATE()) 
) ON [PRIMARY];
GO

DROP TABLE IF EXISTS [Sales].[Store];
GO

CREATE TABLE [Sales].[Store](
    [BusinessEntityID] [int] NOT NULL,
    [Name] [Name] NOT NULL,
    [SalesPersonID] [int] NULL,
    [Demographics] [XML]([Sales].[StoreSurveySchemaCollection]) NULL,
    [rowguid] uniqueidentifier ROWGUIDCOL NOT NULL CONSTRAINT [DF_Store_rowguid] DEFAULT (NEWID()), 
    [ModifiedDate] [datetime] NOT NULL CONSTRAINT [DF_Store_ModifiedDate] DEFAULT (GETDATE()) 
) ON [PRIMARY];
GO

DROP TABLE IF EXISTS [Production].[TransactionHistory];
GO

CREATE TABLE [Production].[TransactionHistory](
    [TransactionID] [int] IDENTITY (100000, 1) NOT NULL,
    [ProductID] [int] NOT NULL,
    [ReferenceOrderID] [int] NOT NULL,
    [ReferenceOrderLineID] [int] NOT NULL CONSTRAINT [DF_TransactionHistory_ReferenceOrderLineID] DEFAULT (0),
    [TransactionDate] [datetime] NOT NULL CONSTRAINT [DF_TransactionHistory_TransactionDate] DEFAULT (GETDATE()),
    [TransactionType] [nchar](1) NOT NULL, 
    [Quantity] [int] NOT NULL,
    [ActualCost] [money] NOT NULL, 
    [ModifiedDate] [datetime] NOT NULL CONSTRAINT [DF_TransactionHistory_ModifiedDate] DEFAULT (GETDATE()),
    CONSTRAINT [CK_TransactionHistory_TransactionType] CHECK (UPPER([TransactionType]) IN ('W', 'S', 'P'))
) ON [PRIMARY];
GO

DROP TABLE IF EXISTS [Production].[TransactionHistoryArchive];
GO

CREATE TABLE [Production].[TransactionHistoryArchive](
    [TransactionID] [int] NOT NULL,
    [ProductID] [int] NOT NULL,
    [ReferenceOrderID] [int] NOT NULL,
    [ReferenceOrderLineID] [int] NOT NULL CONSTRAINT [DF_TransactionHistoryArchive_ReferenceOrderLineID] DEFAULT (0),
    [TransactionDate] [datetime] NOT NULL CONSTRAINT [DF_TransactionHistoryArchive_TransactionDate] DEFAULT (GETDATE()),
    [TransactionType] [nchar](1) NOT NULL, 
    [Quantity] [int] NOT NULL,
    [ActualCost] [money] NOT NULL, 
    [ModifiedDate] [datetime] NOT NULL CONSTRAINT [DF_TransactionHistoryArchive_ModifiedDate] DEFAULT (GETDATE()),
    CONSTRAINT [CK_TransactionHistoryArchive_TransactionType] CHECK (UPPER([TransactionType]) IN ('W', 'S', 'P'))
) ON [PRIMARY];
GO

DROP TABLE IF EXISTS [Production].[UnitMeasure];
GO

CREATE TABLE [Production].[UnitMeasure](
    [UnitMeasureCode] [nchar](3) NOT NULL, 
    [Name] [Name] NOT NULL, 
    [ModifiedDate] [datetime] NOT NULL CONSTRAINT [DF_UnitMeasure_ModifiedDate] DEFAULT (GETDATE()) 
) ON [PRIMARY];
GO

DROP TABLE IF EXISTS [Purchasing].[Vendor];
GO

CREATE TABLE [Purchasing].[Vendor](
    [BusinessEntityID] [int] NOT NULL,
    [AccountNumber] [AccountNumber] NOT NULL,
    [Name] [Name] NOT NULL,
    [CreditRating] [tinyint] NOT NULL,
    [PreferredVendorStatus] [Flag] NOT NULL CONSTRAINT [DF_Vendor_PreferredVendorStatus] DEFAULT (1), 
    [ActiveFlag] [Flag] NOT NULL CONSTRAINT [DF_Vendor_ActiveFlag] DEFAULT (1),
    [PurchasingWebServiceURL] [nvarchar](1024) NULL, 
    [ModifiedDate] [datetime] NOT NULL CONSTRAINT [DF_Vendor_ModifiedDate] DEFAULT (GETDATE()),
    CONSTRAINT [CK_Vendor_CreditRating] CHECK ([CreditRating] BETWEEN 1 AND 5)
) ON [PRIMARY];
GO

DROP TABLE IF EXISTS [Production].[WorkOrder];
GO

CREATE TABLE [Production].[WorkOrder](
    [WorkOrderID] [int] IDENTITY (1, 1) NOT NULL,
    [ProductID] [int] NOT NULL,
    [OrderQty] [int] NOT NULL,
    [StockedQty] AS ISNULL([OrderQty] - [ScrappedQty], 0),
    [ScrappedQty] [smallint] NOT NULL,
    [StartDate] [datetime] NOT NULL,
    [EndDate] [datetime] NULL,
    [DueDate] [datetime] NOT NULL,
    [ScrapReasonID] [smallint] NULL, 
    [ModifiedDate] [datetime] NOT NULL CONSTRAINT [DF_WorkOrder_ModifiedDate] DEFAULT (GETDATE()), 
    CONSTRAINT [CK_WorkOrder_OrderQty] CHECK ([OrderQty] > 0), 
    CONSTRAINT [CK_WorkOrder_ScrappedQty] CHECK ([ScrappedQty] >= 0), 
    CONSTRAINT [CK_WorkOrder_EndDate] CHECK (([EndDate] >= [StartDate]) OR ([EndDate] IS NULL))
) ON [PRIMARY];
GO

DROP TABLE IF EXISTS [Production].[WorkOrderRouting];
GO

CREATE TABLE [Production].[WorkOrderRouting](
    [WorkOrderID] [int] NOT NULL,
    [ProductID] [int] NOT NULL,
    [OperationSequence] [smallint] NOT NULL,
    [LocationID] [smallint] NOT NULL,
    [ScheduledStartDate] [datetime] NOT NULL,
    [ScheduledEndDate] [datetime] NOT NULL,
    [ActualStartDate] [datetime] NULL,
    [ActualEndDate] [datetime] NULL,
    [ActualResourceHrs] [decimal](9, 4) NULL,
    [PlannedCost] [money] NOT NULL,
    [ActualCost] [money] NULL, 
    [ModifiedDate] [datetime] NOT NULL CONSTRAINT [DF_WorkOrderRouting_ModifiedDate] DEFAULT (GETDATE()), 
    CONSTRAINT [CK_WorkOrderRouting_ScheduledEndDate] CHECK ([ScheduledEndDate] >= [ScheduledStartDate]), 
    CONSTRAINT [CK_WorkOrderRouting_ActualEndDate] CHECK (([ActualEndDate] >= [ActualStartDate]) 
        OR ([ActualEndDate] IS NULL) OR ([ActualStartDate] IS NULL)), 
    CONSTRAINT [CK_WorkOrderRouting_ActualResourceHrs] CHECK ([ActualResourceHrs] >= 0.0000), 
    CONSTRAINT [CK_WorkOrderRouting_PlannedCost] CHECK ([PlannedCost] > 0.00), 
    CONSTRAINT [CK_WorkOrderRouting_ActualCost] CHECK ([ActualCost] > 0.00) 
) ON [PRIMARY];
GO

-- ******************************************************
-- Add Primary Keys
-- ******************************************************
PRINT '';
PRINT '*** Adding Primary Keys';
GO

SET QUOTED_IDENTIFIER ON;

ALTER TABLE [Person].[Address] WITH CHECK ADD 
    CONSTRAINT [PK_Address_AddressID] PRIMARY KEY CLUSTERED 
    (
        [AddressID]
    )  ON [PRIMARY];
GO

ALTER TABLE [Person].[AddressType] WITH CHECK ADD 
    CONSTRAINT [PK_AddressType_AddressTypeID] PRIMARY KEY CLUSTERED 
    (
        [AddressTypeID]
    )  ON [PRIMARY];
GO

ALTER TABLE [dbo].[AWBuildVersion] WITH CHECK ADD 
    CONSTRAINT [PK_AWBuildVersion_SystemInformationID] PRIMARY KEY CLUSTERED 
    (
        [SystemInformationID]
    )  ON [PRIMARY];
GO

ALTER TABLE [Production].[BillOfMaterials] WITH CHECK ADD 
    CONSTRAINT [PK_BillOfMaterials_BillOfMaterialsID] PRIMARY KEY NONCLUSTERED
    (
        [BillOfMaterialsID]
    )  ON [PRIMARY];
GO

ALTER TABLE [Person].[BusinessEntity] WITH CHECK ADD 
    CONSTRAINT [PK_BusinessEntity_BusinessEntityID] PRIMARY KEY CLUSTERED 
    (
        [BusinessEntityID]
    )  ON [PRIMARY];
GO

ALTER TABLE [Person].[BusinessEntityAddress] WITH CHECK ADD 
    CONSTRAINT [PK_BusinessEntityAddress_BusinessEntityID_AddressID_AddressTypeID] PRIMARY KEY CLUSTERED 
    (
        [BusinessEntityID],
		[AddressID],
		[AddressTypeID]
    )  ON [PRIMARY];
GO

ALTER TABLE [Person].[BusinessEntityContact] WITH CHECK ADD 
    CONSTRAINT [PK_BusinessEntityContact_BusinessEntityID_PersonID_ContactTypeID] PRIMARY KEY CLUSTERED 
    (
        [BusinessEntityID],
		[PersonID],
		[ContactTypeID]
    )  ON [PRIMARY];
GO

ALTER TABLE [Person].[ContactType] WITH CHECK ADD 
    CONSTRAINT [PK_ContactType_ContactTypeID] PRIMARY KEY CLUSTERED 
    (
        [ContactTypeID]
    )  ON [PRIMARY];
GO

ALTER TABLE [Sales].[CountryRegionCurrency] WITH CHECK ADD 
    CONSTRAINT [PK_CountryRegionCurrency_CountryRegionCode_CurrencyCode] PRIMARY KEY CLUSTERED 
    (
        [CountryRegionCode],
        [CurrencyCode]
    )  ON [PRIMARY];
GO

ALTER TABLE [Person].[CountryRegion] WITH CHECK ADD 
    CONSTRAINT [PK_CountryRegion_CountryRegionCode] PRIMARY KEY CLUSTERED 
    (
        [CountryRegionCode]
    )  ON [PRIMARY];
GO

ALTER TABLE [Sales].[CreditCard] WITH CHECK ADD 
    CONSTRAINT [PK_CreditCard_CreditCardID] PRIMARY KEY CLUSTERED 
    (
        [CreditCardID]
    )  ON [PRIMARY];
GO

ALTER TABLE [Production].[Culture] WITH CHECK ADD 
    CONSTRAINT [PK_Culture_CultureID] PRIMARY KEY CLUSTERED 
    (
        [CultureID]
    )  ON [PRIMARY];
GO

ALTER TABLE [Sales].[Currency] WITH CHECK ADD 
    CONSTRAINT [PK_Currency_CurrencyCode] PRIMARY KEY CLUSTERED 
    (
        [CurrencyCode]
    )  ON [PRIMARY];
GO

ALTER TABLE [Sales].[CurrencyRate] WITH CHECK ADD 
    CONSTRAINT [PK_CurrencyRate_CurrencyRateID] PRIMARY KEY CLUSTERED 
    (
        [CurrencyRateID]
    )  ON [PRIMARY];
GO

ALTER TABLE [Sales].[Customer] WITH CHECK ADD 
    CONSTRAINT [PK_Customer_CustomerID] PRIMARY KEY CLUSTERED 
    (
        [CustomerID]
    )  ON [PRIMARY];
GO

ALTER TABLE [HumanResources].[Department] WITH CHECK ADD 
    CONSTRAINT [PK_Department_DepartmentID] PRIMARY KEY CLUSTERED 
    (
        [DepartmentID]
    )  ON [PRIMARY];
GO

ALTER TABLE [Production].[Document] WITH CHECK ADD 
    CONSTRAINT [PK_Document_DocumentNode] PRIMARY KEY CLUSTERED 
    (
        [DocumentNode]
    )  ON [PRIMARY];
GO

ALTER TABLE [Person].[EmailAddress] WITH CHECK ADD 
    CONSTRAINT [PK_EmailAddress_BusinessEntityID_EmailAddressID] PRIMARY KEY CLUSTERED 
    (
        [BusinessEntityID],
		[EmailAddressID]
    )  ON [PRIMARY];
GO

ALTER TABLE [HumanResources].[Employee] WITH CHECK ADD 
    CONSTRAINT [PK_Employee_BusinessEntityID] PRIMARY KEY CLUSTERED 
    (
        [BusinessEntityID]
    )  ON [PRIMARY];
GO

ALTER TABLE [HumanResources].[EmployeeDepartmentHistory] WITH CHECK ADD 
    CONSTRAINT [PK_EmployeeDepartmentHistory_BusinessEntityID_StartDate_DepartmentID] PRIMARY KEY CLUSTERED 
    (
        [BusinessEntityID],
        [StartDate],
        [DepartmentID],
        [ShiftID]
    )  ON [PRIMARY];
GO

ALTER TABLE [HumanResources].[EmployeePayHistory] WITH CHECK ADD 
    CONSTRAINT [PK_EmployeePayHistory_BusinessEntityID_RateChangeDate] PRIMARY KEY CLUSTERED 
    (
        [BusinessEntityID],
        [RateChangeDate]
    )  ON [PRIMARY];
GO

ALTER TABLE [Production].[Illustration] WITH CHECK ADD 
    CONSTRAINT [PK_Illustration_IllustrationID] PRIMARY KEY CLUSTERED 
    (
        [IllustrationID]
    )  ON [PRIMARY];
GO


ALTER TABLE [HumanResources].[JobCandidate] WITH CHECK ADD 
    CONSTRAINT [PK_JobCandidate_JobCandidateID] PRIMARY KEY CLUSTERED 
    (
        [JobCandidateID]
    )  ON [PRIMARY];
GO

ALTER TABLE [Production].[Location] WITH CHECK ADD 
    CONSTRAINT [PK_Location_LocationID] PRIMARY KEY CLUSTERED 
    (
        [LocationID]
    )  ON [PRIMARY];
GO

ALTER TABLE [Person].[Password] WITH CHECK ADD 
    CONSTRAINT [PK_Password_BusinessEntityID] PRIMARY KEY CLUSTERED 
    (
        [BusinessEntityID]
    )  ON [PRIMARY];
GO

ALTER TABLE [Person].[Person] WITH CHECK ADD 
    CONSTRAINT [PK_Person_BusinessEntityID] PRIMARY KEY CLUSTERED 
    (
        [BusinessEntityID]
    )  ON [PRIMARY];
GO

ALTER TABLE [Sales].[PersonCreditCard] WITH CHECK ADD 
    CONSTRAINT [PK_PersonCreditCard_BusinessEntityID_CreditCardID] PRIMARY KEY CLUSTERED 
    (
        [BusinessEntityID],
        [CreditCardID]
    )  ON [PRIMARY];
GO

ALTER TABLE [Person].[PersonPhone] WITH CHECK ADD 
    CONSTRAINT [PK_PersonPhone_BusinessEntityID_PhoneNumber_PhoneNumberTypeID] PRIMARY KEY CLUSTERED 
    (
        [BusinessEntityID],
        [PhoneNumber],
        [PhoneNumberTypeID]
    )  ON [PRIMARY];
GO

ALTER TABLE [Person].[PhoneNumberType] WITH CHECK ADD 
    CONSTRAINT [PK_PhoneNumberType_PhoneNumberTypeID] PRIMARY KEY CLUSTERED 
    (
        [PhoneNumberTypeID]
    )  ON [PRIMARY];
GO

ALTER TABLE [Production].[Product] WITH CHECK ADD 
    CONSTRAINT [PK_Product_ProductID] PRIMARY KEY CLUSTERED 
    (
        [ProductID]
    )  ON [PRIMARY];
GO

ALTER TABLE [Production].[ProductCategory] WITH CHECK ADD 
    CONSTRAINT [PK_ProductCategory_ProductCategoryID_CultureID] PRIMARY KEY CLUSTERED 
    (
        [ProductCategoryID],
        [CultureID]
    )  ON [PRIMARY];
GO

ALTER TABLE [Production].[ProductCategory] WITH CHECK ADD
    CONSTRAINT [FK_ProductCategory_Culture_CultureID] FOREIGN KEY([CultureID])
    REFERENCES [Production].[Culture] ([CultureID]);
GO

ALTER TABLE [Production].[ProductCostHistory] WITH CHECK ADD 
    CONSTRAINT [PK_ProductCostHistory_ProductID_StartDate] PRIMARY KEY CLUSTERED 
    (
        [ProductID],
        [StartDate]
    )  ON [PRIMARY];
GO

ALTER TABLE [Production].[ProductDescription] WITH CHECK ADD 
    CONSTRAINT [PK_ProductDescription_ProductDescriptionID] PRIMARY KEY CLUSTERED 
    (
        [ProductDescriptionID]
    )  ON [PRIMARY];
GO

ALTER TABLE [Production].[ProductDocument] WITH CHECK ADD 
    CONSTRAINT [PK_ProductDocument_ProductID_DocumentNode] PRIMARY KEY CLUSTERED 
    (
        [ProductID],
        [DocumentNode]
    )  ON [PRIMARY];
GO

ALTER TABLE [Production].[ProductInventory] WITH CHECK ADD 
    CONSTRAINT [PK_ProductInventory_ProductID_LocationID] PRIMARY KEY CLUSTERED 
    (
    [ProductID],
    [LocationID]
    )  ON [PRIMARY];
GO

ALTER TABLE [Production].[ProductListPriceHistory] WITH CHECK ADD 
    CONSTRAINT [PK_ProductListPriceHistory_ProductID_StartDate] PRIMARY KEY CLUSTERED 
    (
        [ProductID],
        [StartDate]
    )  ON [PRIMARY];
GO

ALTER TABLE [Production].[ProductModel] WITH CHECK ADD 
    CONSTRAINT [PK_ProductModel_ProductModelID] PRIMARY KEY CLUSTERED 
    (
        [ProductModelID]
    )  ON [PRIMARY];
GO

ALTER TABLE [Production].[ProductModelIllustration] WITH CHECK ADD 
    CONSTRAINT [PK_ProductModelIllustration_ProductModelID_IllustrationID] PRIMARY KEY CLUSTERED 
    (
        [ProductModelID],
        [IllustrationID]
    )  ON [PRIMARY];
GO

ALTER TABLE [Production].[ProductModelProductDescriptionCulture] WITH CHECK ADD 
    CONSTRAINT [PK_ProductModelProductDescriptionCulture_ProductModelID_ProductDescriptionID_CultureID] PRIMARY KEY CLUSTERED 
    (
        [ProductModelID],
        [ProductDescriptionID],
        [CultureID]
    )  ON [PRIMARY];
GO

ALTER TABLE [Production].[ProductPhoto] WITH CHECK ADD 
    CONSTRAINT [PK_ProductPhoto_ProductPhotoID] PRIMARY KEY CLUSTERED 
    (
        [ProductPhotoID]
    )  ON [PRIMARY];
GO

ALTER TABLE [Production].[ProductProductPhoto] WITH CHECK ADD 
    CONSTRAINT [PK_ProductProductPhoto_ProductID_ProductPhotoID] PRIMARY KEY NONCLUSTERED 
    (
        [ProductID],
        [ProductPhotoID]
    )  ON [PRIMARY];
GO

ALTER TABLE [Production].[ProductReview] WITH CHECK ADD 
    CONSTRAINT [PK_ProductReview_ProductReviewID] PRIMARY KEY CLUSTERED 
    (
        [ProductReviewID]
    )  ON [PRIMARY];
GO

ALTER TABLE [Production].[ProductSubcategory] WITH CHECK ADD 
    CONSTRAINT [PK_ProductSubcategory_ProductSubcategoryID_CultureID] PRIMARY KEY CLUSTERED 
    (
        [ProductSubcategoryID],
        [CultureID]
    )  ON [PRIMARY];
GO

ALTER TABLE [Production].[ProductSubcategory] WITH CHECK ADD
    CONSTRAINT [FK_ProductSubcategory_Culture_CultureID] FOREIGN KEY([CultureID])
    REFERENCES [Production].[Culture] ([CultureID]);
GO

ALTER TABLE [Purchasing].[ProductVendor] WITH CHECK ADD 
    CONSTRAINT [PK_ProductVendor_ProductID_BusinessEntityID] PRIMARY KEY CLUSTERED 
    (
        [ProductID],
        [BusinessEntityID]
    )  ON [PRIMARY];
GO

ALTER TABLE [Purchasing].[PurchaseOrderDetail] WITH CHECK ADD 
    CONSTRAINT [PK_PurchaseOrderDetail_PurchaseOrderID_PurchaseOrderDetailID] PRIMARY KEY CLUSTERED 
    (
        [PurchaseOrderID],
        [PurchaseOrderDetailID]
    )  ON [PRIMARY];
GO

ALTER TABLE [Purchasing].[PurchaseOrderHeader] WITH CHECK ADD 
    CONSTRAINT [PK_PurchaseOrderHeader_PurchaseOrderID] PRIMARY KEY CLUSTERED 
    (
        [PurchaseOrderID]
    )  ON [PRIMARY];
GO

ALTER TABLE [Sales].[SalesOrderDetail] WITH CHECK ADD 
    CONSTRAINT [PK_SalesOrderDetail_SalesOrderID_SalesOrderDetailID] PRIMARY KEY CLUSTERED 
    (
        [SalesOrderID],
        [SalesOrderDetailID]
    )  ON [PRIMARY];
GO

ALTER TABLE [Sales].[SalesOrderHeader] WITH CHECK ADD 
    CONSTRAINT [PK_SalesOrderHeader_SalesOrderID] PRIMARY KEY CLUSTERED 
    (
        [SalesOrderID]
    )  ON [PRIMARY];
GO

ALTER TABLE [Sales].[SalesOrderHeaderSalesReason] WITH CHECK ADD 
    CONSTRAINT [PK_SalesOrderHeaderSalesReason_SalesOrderID_SalesReasonID] PRIMARY KEY CLUSTERED 
    (
        [SalesOrderID],
        [SalesReasonID]
    )  ON [PRIMARY];
GO

ALTER TABLE [Sales].[SalesPerson] WITH CHECK ADD 
    CONSTRAINT [PK_SalesPerson_BusinessEntityID] PRIMARY KEY CLUSTERED 
    (
        [BusinessEntityID]
    )  ON [PRIMARY];
GO

ALTER TABLE [Sales].[SalesPersonQuotaHistory] WITH CHECK ADD 
    CONSTRAINT [PK_SalesPersonQuotaHistory_BusinessEntityID_QuotaDate] PRIMARY KEY CLUSTERED 
    (
        [BusinessEntityID],
        [QuotaDate]
    )  ON [PRIMARY];
GO

ALTER TABLE [Sales].[SalesReason] WITH CHECK ADD 
    CONSTRAINT [PK_SalesReason_SalesReasonID] PRIMARY KEY CLUSTERED 
    (
        [SalesReasonID]
    )  ON [PRIMARY];
GO
 
ALTER TABLE [Sales].[SalesTaxRate] WITH CHECK ADD 
    CONSTRAINT [PK_SalesTaxRate_SalesTaxRateID] PRIMARY KEY CLUSTERED 
    (
        [SalesTaxRateID]
    )  ON [PRIMARY];
GO

ALTER TABLE [Sales].[SalesTerritory] WITH CHECK ADD 
    CONSTRAINT [PK_SalesTerritory_TerritoryID] PRIMARY KEY CLUSTERED 
    (
        [TerritoryID]
    )  ON [PRIMARY];
GO

ALTER TABLE [Sales].[SalesTerritoryHistory] WITH CHECK ADD 
    CONSTRAINT [PK_SalesTerritoryHistory_BusinessEntityID_StartDate_TerritoryID] PRIMARY KEY CLUSTERED 
    (
        [BusinessEntityID],
        [StartDate],
        [TerritoryID]
    )  ON [PRIMARY];
GO

ALTER TABLE [Production].[ScrapReason] WITH CHECK ADD 
    CONSTRAINT [PK_ScrapReason_ScrapReasonID] PRIMARY KEY CLUSTERED 
    (
        [ScrapReasonID]
    )  ON [PRIMARY];
GO

ALTER TABLE [HumanResources].[Shift] WITH CHECK ADD 
    CONSTRAINT [PK_Shift_ShiftID] PRIMARY KEY CLUSTERED 
    (
        [ShiftID]
    )  ON [PRIMARY];
GO

ALTER TABLE [Purchasing].[ShipMethod] WITH CHECK ADD 
    CONSTRAINT [PK_ShipMethod_ShipMethodID] PRIMARY KEY CLUSTERED 
    (
        [ShipMethodID]
    )  ON [PRIMARY];
GO

ALTER TABLE [Sales].[ShoppingCartItem] WITH CHECK ADD 
    CONSTRAINT [PK_ShoppingCartItem_ShoppingCartItemID] PRIMARY KEY CLUSTERED 
    (
        [ShoppingCartItemID]
    )  ON [PRIMARY];
GO

ALTER TABLE [Sales].[SpecialOffer] WITH CHECK ADD 
    CONSTRAINT [PK_SpecialOffer_SpecialOfferID_CultureID] PRIMARY KEY CLUSTERED 
    (
        [SpecialOfferID],
        [CultureID]
    )  ON [PRIMARY];
GO

ALTER TABLE [Sales].[SpecialOffer] WITH CHECK ADD
    CONSTRAINT [FK_SpecialOffer_Culture_CultureID] FOREIGN KEY([CultureID])
    REFERENCES [Production].[Culture] ([CultureID]);
GO

ALTER TABLE [Sales].[SpecialOfferProduct] WITH CHECK ADD 
    CONSTRAINT [PK_SpecialOfferProduct_SpecialOfferID_ProductID] PRIMARY KEY CLUSTERED 
    (
        [SpecialOfferID],
        [ProductID]
    )  ON [PRIMARY];
GO

ALTER TABLE [Person].[StateProvince] WITH CHECK ADD 
    CONSTRAINT [PK_StateProvince_StateProvinceID] PRIMARY KEY CLUSTERED 
    (
        [StateProvinceID]
    )  ON [PRIMARY];
GO

ALTER TABLE [Sales].[Store] WITH CHECK ADD 
    CONSTRAINT [PK_Store_BusinessEntityID] PRIMARY KEY CLUSTERED 
    (
        [BusinessEntityID]
    )  ON [PRIMARY];
GO

ALTER TABLE [Production].[TransactionHistory] WITH CHECK ADD 
    CONSTRAINT [PK_TransactionHistory_TransactionID] PRIMARY KEY CLUSTERED 
    (
        [TransactionID]
    )  ON [PRIMARY];
GO

ALTER TABLE [Production].[TransactionHistoryArchive] WITH CHECK ADD 
    CONSTRAINT [PK_TransactionHistoryArchive_TransactionID] PRIMARY KEY CLUSTERED 
    (
        [TransactionID]
    )  ON [PRIMARY];
GO

ALTER TABLE [Production].[UnitMeasure] WITH CHECK ADD 
    CONSTRAINT [PK_UnitMeasure_UnitMeasureCode] PRIMARY KEY CLUSTERED 
    (
        [UnitMeasureCode]
    )  ON [PRIMARY];
GO

ALTER TABLE [Purchasing].[Vendor] WITH CHECK ADD 
    CONSTRAINT [PK_Vendor_BusinessEntityID] PRIMARY KEY CLUSTERED 
    (
        [BusinessEntityID]
    )  ON [PRIMARY];
GO

ALTER TABLE [Production].[WorkOrder] WITH CHECK ADD 
    CONSTRAINT [PK_WorkOrder_WorkOrderID] PRIMARY KEY CLUSTERED 
    (
        [WorkOrderID]
    )  ON [PRIMARY];
GO

ALTER TABLE [Production].[WorkOrderRouting] WITH CHECK ADD 
    CONSTRAINT [PK_WorkOrderRouting_WorkOrderID_ProductID_OperationSequence] PRIMARY KEY CLUSTERED 
    (
        [WorkOrderID],
        [ProductID],
        [OperationSequence]
    )  ON [PRIMARY];
GO

PRINT 'Finished - ' + CONVERT(varchar, GETDATE(), 121);
GO
